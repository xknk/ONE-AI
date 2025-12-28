/*
 * @Author: Robin LEI
 * @Date: 2025-12-11 09:38:48
 * @LastEditTime: 2025-12-24 16:45:03
 * @FilePath: \ONE-AI\app\serve\src\agent.ts
 */
import { ChatOllama } from "@langchain/ollama";
import { PostgresChatMessageHistory } from "@langchain/community/stores/message/postgres"; // 引入持久化存储
import http from "node:http"
import querystring from "node:querystring"; // 新增：解析请求参数
import { MessagesAnnotation, StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { tools, toolNode } from "./embeddings/tool.js";
import { getAgentPrompt } from "./prompts/loader.js"
// 1. 配置与实例初始化
const pgConfig = {
    host: "127.0.0.1",
    port: 5432,
    user: "fanxiaosi",
    password: "f15130026310.",
    database: "One-AI-DB",
};

// 1、创建llm实例
const llm: any = new ChatOllama({
    model: 'qwen2.5:3b',
    baseUrl: "http://127.0.0.1:11434", // 使用IPv4地址避免连接问题
    topP: 0.9,
    topK: 40,
    streaming: true,
    temperature: 0,
    repeatPenalty: 1.2,  // 防止模型在多轮对话后开始复读系统指令
    numPredict: 512, // 限制单次回复长度

})


// 绑定工具到模型
const modelWithTools = llm.bindTools(tools);
// --- 1. 定义状态 (解决 userName 类型报错) ---
const MyStateAnnotation = Annotation.Root({
    ...MessagesAnnotation.spec,
    userName: Annotation<string>({
        reducer: (oldV, newV) => newV ?? oldV,
        default: () => "访客",
    }),
    // userId: Annotation<string>(),       // 数据库唯一ID，用于物理隔离
    // orgId: Annotation<string>(),        // 企业/部门ID，用于权限控制
    // permissions: Annotation<string[]>(), // 工具调用权限清单
    // 2. 业务上下文
    // currentProject: Annotation<string>(), // 正在讨论的项目
    // traceId: Annotation<string>(),       // 全链路追踪 ID，方便排查报错
    // 3. 记忆摘要 (解决长对话卡死)
    summary: Annotation<string>({       // 存储前 20 轮对话的压缩摘要
        reducer: (old, next) => next ?? old
    }),
})

// 节点 1: 模型推理
async function callModel(state: typeof MyStateAnnotation.State) {
    const systemContent = getAgentPrompt({
        // 这里可以注入动态信息
        currentTime: new Date().toLocaleString(),
        userName: state.userName || "访客"
    });
    const systemPrompt = {
        role: "system",
        content: systemContent
    };
    // 优化：只取最近 10 条对话历史送入模型，防止上下文无限增长导致卡死
    // const inputMessages = [systemPrompt, ...state.messages.slice(-10)];
    // 确保系统提示词在首位
    const response = await modelWithTools.invoke([systemPrompt, ...state.messages]);
    return { messages: [response] };
}

// 定义逻辑流
const workflow = new StateGraph(MyStateAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", (state) => {
        console.log(state)
        const lastMessage = state.messages[state.messages.length - 1];
        // 如果模型输出了 tool_calls，则进入 tools 节点，否则结束
        return (lastMessage as any).tool_calls?.length ? "tools" : END;
    })
    .addEdge("tools", "agent"); // 工具执行后回到 agent 总结或继续

const appGraph = workflow.compile();

// 新增：解析请求参数（GET/POST）
async function parseRequestParams(req: any) {
    const query = req.url?.split("?")[1] ? querystring.parse(req.url.split("?")[1]) : {};
    let body = {};
    if (req.method === "POST") {
        body = await new Promise((resolve) => {
            let rawBody = "";
            req.on("data", (chunk: any) => rawBody += chunk);
            req.on("end", () => resolve(JSON.parse(rawBody || "{}")));
        });
    }
    return { ...query, ...body } as Record<string, string>;
}

const app = http.createServer(async (req, res) => {
    // 优化 1：过滤浏览器自动请求的图标文件，直接返回 404
    if (req.url === "/favicon.ico") return (res.writeHead(404), res.end());

    // CORS 处理
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return (res.writeHead(204), res.end());

    try {
        const params = await parseRequestParams(req);
        const sessionId = params.sessionId || "default-session";
        const user_input = params.user_input;

        if (!user_input) return (res.writeHead(400).end("Missing input"));

        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });

        // 获取历史消息
        const history = new PostgresChatMessageHistory({
            tableName: "chat_messages",
            sessionId,
            poolConfig: pgConfig,
        });
        const allPrevMessages = await history.getMessages();
        const prevMessages = allPrevMessages.slice(-5);

        // 运行 Graph
        const stream = await appGraph.stream(
            { messages: [...prevMessages, { role: "user", content: user_input }] },
            {
                configurable: { sessionId },
                recursionLimit: 5 // 如果超过5次迭代（工具调用+回复）强行终止
            },

        );

        let finalContent = "";
        for await (const chunk of stream) {
            // LangGraph 流会返回不同节点的消息
            const agentMsg = chunk.agent?.messages?.[0];
            if (agentMsg?.content) {
                const text = agentMsg.content;
                finalContent += text;
                res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
            }
        }

        // 存储本次对话的消息到 Postgres (仅存对话流，不含向量)
        await history.addUserMessage(user_input);
        if (finalContent) await history.addAIMessage(finalContent);

        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
    } catch (e: any) {
        console.error(e);
        res.end(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    }
})
app.listen(3000, async () => {
    console.log("http://localhost:3000/")
})
/*
 * @Author: Robin LEI
 * 分析：该模块是一个集成 LangGraph 状态机、PostgreSQL 记忆存储、
 * 以及 Ollama 本地模型的智能 Agent 服务端。
 */
import { ChatOllama } from "@langchain/ollama";
import { PostgresChatMessageHistory } from "@langchain/community/stores/message/postgres";
import http from "node:http"
import querystring from "node:querystring";
import { MessagesAnnotation, StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { tools, toolNode } from "./embeddings/tool.js";
import { getAgentPrompt } from "./prompts/loader.js"

// 1. 数据库配置：用于存储聊天记录
const pgConfig = {
    host: "127.0.0.1",
    port: 5432,
    user: "fanxiaosi",
    password: "f15130026310.",
    database: "One-AI-DB",
};

// 2. 初始化 LLM 模型
const llm: any = new ChatOllama({
    model: 'qwen2.5:3b',
    baseUrl: "http://127.0.0.1:11434",
    topP: 0.9,
    topK: 40,
    streaming: true, // 开启流式响应
    temperature: 0, // 设为 0 保证逻辑严谨，减少幻觉
    repeatPenalty: 1.2,
    numPredict: 512,
})

// 将工具绑定到模型，使模型知道自己可以调用哪些外部函数
const modelWithTools = llm.bindTools(tools);

// 3. 定义全局状态 (State)
// 这里决定了在整个对话流中，哪些数据是可以被读取和修改的
const MyStateAnnotation = Annotation.Root({
    ...MessagesAnnotation.spec, // 包含默认的 messages 数组 如： HumanMessage, AIMessage, ToolMessage
    userName: Annotation<string>({
        reducer: (oldV, newV) => newV ?? oldV, // 状态更新逻辑 - 如果有新用户就用新用户，如果没有就用旧得用户，默认值为“访客”
        default: () => "访客",
    }),
    summary: Annotation<string>({ // 预留摘要字段，用于处理超长上下文
        reducer: (old, next) => next ?? old
    }),
})

// 节点 (Node) 1: 模型推理逻辑
async function callModel(state: typeof MyStateAnnotation.State) {
    // 获取系统提示词，注入动态上下文（如当前时间、用户名）
    let systemContent = getAgentPrompt({
        currentTime: new Date().toLocaleString(),
        userName: state.userName || "访客"
    });
    // 2. 如果存在摘要 (summary)，将其注入到系统提示词中
    // 这样模型即便看不到旧的消息，也能通过摘要了解之前的上下文
    if (state.summary) {
        systemContent += `\n\n[历史对话摘要]: ${state.summary}`;
    }
    const systemPrompt = { role: "system", content: systemContent };
    /**
     * 3. 消息切片 (Windowing)
     * 不再发送 state.messages 中的全部消息，只取最近的 6 条。
     * 这样可以确保 Ollama 不会因为上下文太长而变得缓慢或卡死。
     */
    const recentMessages = state.messages.slice(-10);
    // 执行模型调用：组合系统提示词和历史消息
    const response = await modelWithTools.invoke([systemPrompt, ...recentMessages]);
    return { messages: [response] }; // 更新状态中的 messages
}

// 4. 构建工作流图 (LangGraph)
const workflow = new StateGraph(MyStateAnnotation)
    .addNode("agent", callModel)      // 定义推理节点
    .addNode("tools", toolNode)       // 定义工具执行节点
    .addEdge(START, "agent")          // 入口
    .addConditionalEdges("agent", (state) => {
        // 条件分支：判断模型是否需要调用工具
        const lastMessage = state.messages[state.messages.length - 1];
        return (lastMessage as any).tool_calls?.length ? "tools" : END;
    })
    .addEdge("tools", "agent");       // 工具执行完后再次交给模型总结

const appGraph = workflow.compile(); // 编译生成可执行的 Graph

// 5. 辅助函数：解析 HTTP 请求参数
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

// 6. 创建 HTTP Server 并处理请求
const app = http.createServer(async (req, res) => {
    if (req.url === "/favicon.ico") return (res.writeHead(404), res.end());

    // 跨域设置
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return (res.writeHead(204), res.end());

    try {
        const params = await parseRequestParams(req);
        const sessionId = params.sessionId || "default-session";
        const user_input = params.user_input;

        if (!user_input) return (res.writeHead(400).end("Missing input"));

        // 响应头：设置为 SSE 格式实现流式传输
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });

        // 初始化持久化记忆：从 Postgres 加载该用户的历史
        const history = new PostgresChatMessageHistory({
            tableName: "chat_messages",
            sessionId,
            poolConfig: pgConfig,
        });

        const allPrevMessages = await history.getMessages();
        const prevMessages = allPrevMessages.slice(-5); // 只取最近5条，节省 Token

        // 核心执行：运行图逻辑
        const stream = await appGraph.stream(
            { messages: [...prevMessages, { role: "user", content: user_input }] },
            {
                configurable: { sessionId },
                recursionLimit: 5 // 防死循环：限制工具调用次数
            },
        );

        let finalContent = "";
        // 遍历流：监听节点输出并推送到前端
        for await (const chunk of stream) {
            const agentMsg = chunk.agent?.messages?.[0];
            if (agentMsg?.content) {
                const text = agentMsg.content;
                finalContent += text;
                // 按 SSE 协议格式发送数据块
                res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
            }
        }

        // 7. 对话持久化：任务完成后将本次问答存入数据库
        await history.addUserMessage(user_input);
        if (finalContent) await history.addAIMessage(finalContent);

        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
    } catch (e: any) {
        console.error("Server Error:", e);
        res.end(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    }
})

app.listen(3000, async () => {
    console.log("ONE-AI Agent 启动成功: http://localhost:3000/")
})

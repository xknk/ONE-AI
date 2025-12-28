/*
 * @Author: Robin LEI
 * @Date: 2025-12-11 09:38:48
 * @LastEditTime: 2025-12-24 10:50:21
 * @FilePath: \ONE-AI\app\serve\history\PG\prompt.ts
 */
import { ChatOllama } from "@langchain/ollama";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableWithMessageHistory, RunnableLambda, RunnableSequence, RunnablePassthrough } from "@langchain/core/runnables";
import { addMessageToVectorStore, retrieveRelevantHistory } from "./embeddings/mxbai-embed-large.js";
import { PostgresChatMessageHistory } from "@langchain/community/stores/message/postgres"; // 引入持久化存储
import http from "node:http"
import querystring from "node:querystring"; // 新增：解析请求参数


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
    model: 'qwen2.5:7b',
    baseUrl: "http://127.0.0.1:11434", // 使用IPv4地址避免连接问题
    topP: 0.9,
    topK: 40,
    streaming: true,
    temperature: 0,
    repeatPenalty: 1.2,  // 防止模型在多轮对话后开始复读系统指令
})

// 纯文本提示模板（修复：使用 fromMessages 来正确处理消息历史数组）
const textPrompt = ChatPromptTemplate.fromMessages([
    ["system", "你是一个专业的知识助手。只需回答用户问题，不要重复系统指令。如果无法从背景信息中找到答案，请基于已知对话回复。"],
    ["placeholder", "{chat_history}"],
    ["human", "背景信息：{relevant_history}\n\n当前问题：{user_input}"]
]);

// 自定义敏感词检查步骤
const profanityChecker = (input: { user_input: string }) => {
    const sensitiveWords = ["傻瓜", "白痴", "不良内容"]; // 示例敏感词
    const userInput = input.user_input;

    if (sensitiveWords.some(word => userInput.includes(word))) {
        // 您可以选择抛出错误，或者返回一个特定的响应对象
        // 如果抛出错误，整个链会停止执行
        throw new Error("检测到敏感内容。请使用文明用语。");
    }

    // 如果通过检查，返回原始输入，让链继续执行
    return input;
};
const customCheckStep = RunnableLambda.from(profanityChecker);
/**
 * 包装检索逻辑为Runnable（适配LangChain链式调用）
 */
const retrieveStep = RunnableLambda.from(async (input: { user_input: string; sessionId: string }) => {
    if (input.user_input.length < 3) return ""; // 改为空字符串
    const history = await retrieveRelevantHistory(input.user_input, input.sessionId);
    // 如果返回的是默认的“无相关...”，也改为空字符串
    return history === "无相关背景知识" ? "" : history;
});
// 3、重构链式调用：先格式化历史，再注入模板
const ragChain = customCheckStep
    .pipe({
        user_input: (input: any) => input.user_input,
        sessionId: (_input: any, config: any) => config.configurable?.sessionId,
        chat_history: (input: any) => input.chat_history,
    })
    .pipe(
        RunnablePassthrough.assign({
            relevant_history: retrieveStep,
        })
    )
    .pipe(textPrompt)
    .pipe(llm);


// 2、修复提示词模板：仅保留核心逻辑，依赖格式化后的历史
const textChainWithHistory = new RunnableWithMessageHistory<any, any>({
    runnable: ragChain,
    // 关键修复：确保始终返回有效的历史实例
    getMessageHistory: (sessionId: string) => {
        // 自动在 Postgres 中管理 session，重启不丢失历史
        return new PostgresChatMessageHistory({
            tableName: "chat_messages",
            sessionId,
            poolConfig: pgConfig,
        });
    },
    inputMessagesKey: "user_input", // 输入文本的字段名
    historyMessagesKey: "chat_history", // 注入到提示词的历史字段名
} as any);

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
    if (req.url === "/favicon.ico") {
        res.writeHead(404);
        res.end();
        return;
    }
    // 新增：处理跨域预检请求
    if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.writeHead(204);
        res.end();
        return;
    }


    try {
        // 解析请求参数（替换硬编码的sessionId和text）
        const params = await parseRequestParams(req);
        const sessionId = params.sessionId || "default-session-id";
        const user_input = params.user_input;
        // 设置 SSE 响应头
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (!user_input) {
            res.writeHead(400).end("Missing user_input");
            return;
        }
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        });
        const stream = await textChainWithHistory.stream(
            { user_input },
            { configurable: { sessionId } }
        );
        let fullSummary = "";
        for await (const chunk of stream) {
            const content = chunk.content || "";
            fullSummary += content;
            // 按照 SSE 格式发送：data: {内容}\n\n
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }

        // 发送结束事件（可选）
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);

        // 修复：将AI的回复也存储到向量库
        if (fullSummary) {
            await addMessageToVectorStore(sessionId, user_input, fullSummary);
        }
        res.end();
    } catch (error: any) {
        console.error("Chain Error:", error);
        // 通过 SSE 发送错误消息给前端
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    }
})
app.listen(3000, async () => {
    console.log("http://localhost:3000/")
})
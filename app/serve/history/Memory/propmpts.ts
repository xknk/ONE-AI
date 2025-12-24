/*
 * @Author: Robin LEI
 * @Date: 2025-12-11 09:38:48
 * @LastEditTime: 2025-12-23 10:11:22
 * @FilePath: \ONE-AI\app\test\propmpts-neicun.ts
 */
import { ChatOllama } from "@langchain/ollama";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages"
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { InMemoryChatMessageHistory, BaseChatMessageHistory } from "@langchain/core/chat_history"; // 新增：内置内存存储
import { RunnableWithMessageHistory, RunnableLambda, RunnableSequence, RunnablePassthrough } from "@langchain/core/runnables";
import { addMessageToVectorStore, getSessionStore, retrieveRelevantHistory } from "./embeddings/mxbai-embed-large.js";

import http from "node:http"
import querystring from "node:querystring"; // 新增：解析请求参数

// 1、创建llm实例
const llm = new ChatOllama({
    model: 'deepseek-r1:1.5b',
    baseUrl: "http://127.0.0.1:11434", // 使用IPv4地址避免连接问题
    topP: 1.0,
    topK: 20,
    streaming: true,
})

// 纯文本提示模板（修复：使用 fromMessages 来正确处理消息历史数组）
const textPrompt = ChatPromptTemplate.fromMessages([
    ["system", "你是一个智能聊天助手，具有记忆功能。请仔细阅读历史对话，从中提取关键信息来回答用户的问题。"],
    ["placeholder", "{chat_history}"], // 使用 placeholder 占位符来注入历史消息数组
    ["human", "{user_input}"]
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
    return await retrieveRelevantHistory(input.user_input, input.sessionId);
});
// 3、重构链式调用：先格式化历史，再注入模板
const ragChain = RunnableSequence.from([
    customCheckStep, // 新增：敏感词检查步骤
    // 步骤2：透传参数 + 注入会话ID + 检索相似历史
    // 注意：不要重新定义输入对象，否则会覆盖 RunnableWithMessageHistory 注入的 chat_history
    RunnablePassthrough.assign({
        sessionId: (_, config) => config.configurable.sessionId, // 从配置取会话ID
        relevant_history: retrieveStep, // 检索相似历史（核心RAG步骤）
    }),
    // 第二步：注入到提示词模板（user_input 和 chat_history 会自动从输入中获取）
    textPrompt,
    // 第三步：调用LLM
    llm,
]);
const sessionHistories: Record<string, BaseChatMessageHistory> = {};

// 2、修复提示词模板：仅保留核心逻辑，依赖格式化后的历史
const textChainWithHistory = new RunnableWithMessageHistory<any, any>({
    runnable: ragChain,
    // 关键修复：确保始终返回有效的历史实例
    getMessageHistory:  async (sessionId: string) => {
        // 关键修改：从 getSessionStore 中获取 chatHistory，而非自己创建
        const sessionStore = await getSessionStore(sessionId);
        return sessionStore.chatHistory; // 复用同一个历史实例
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
    // 新增：处理跨域预检请求
    if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.writeHead(204);
        res.end();
        return;
    }

    // 解析请求参数（替换硬编码的sessionId和text）
    const params = await parseRequestParams(req);
    const sessionId = params.sessionId || "default-summary-session-001";
    const user_input = params.user_input || "1+1等于几";
    // 设置 SSE 响应头
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
    });
    await addMessageToVectorStore(sessionId, user_input);
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
})
app.listen(3000, async () => {
    console.log("http://localhost:3000/")
})
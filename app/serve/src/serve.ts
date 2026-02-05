import http from "node:http"
import { PostgresChatMessageHistory } from "@langchain/community/stores/message/postgres";
import querystring from "node:querystring";
import { graph } from "./agent.js";
// 1. 数据库配置
const pgConfig = {
    host: "127.0.0.1",
    port: 5432,
    user: "fanxiaosi",
    password: "f15130026310.",
    database: "One-AI-DB",
};
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
/**
 * 【关键点 2】：原有 HTTP 服务逻辑
 * 建议将其封装在函数中或保持现状，
 * 但运行 CLI 时，CLI 会加载此文件。
 */
const server = http.createServer(async (req, res) => {
    if (req.url === "/favicon.ico") return (res.writeHead(404), res.end());
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

        const history = new PostgresChatMessageHistory({
            tableName: "chat_messages",
            sessionId,
            poolConfig: pgConfig,
        });

        const allPrevMessages = await history.getMessages();
        const prevMessages = allPrevMessages.slice(-5);

        // 使用编译好的 graph 运行流
        const stream = await graph.stream(
            { messages: [...prevMessages, { role: "user", content: user_input }] },
            {
                configurable: { sessionId },
                recursionLimit: 5 
            },
        );

        let finalContent = "";
        for await (const chunk of stream) {
            const agentMsg = (chunk as any).agent?.messages?.[0];
            if (agentMsg?.content) {
                const text = agentMsg.content;
                finalContent += text;
                res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
            }
        }

        await history.addUserMessage(user_input);
        if (finalContent) await history.addAIMessage(finalContent);

        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
    } catch (e: any) {
        console.error("Server Error:", e);
        res.end(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    }
});

/**
 * 【关键点 3】：避免端口冲突
 * 如果你运行 npx langgraph dev，CLI 会占用端口。
 * 如果只是为了开发调试图，可以暂时不运行 server.listen。
 */
if (process.env.NODE_ENV !== 'production' && !process.argv.includes('--langgraph-dev')) {
    server.listen(3000, () => {
        console.log("ONE-AI Agent 手动模式启动: http://localhost:3000/");
    });
}
/*
 * @Author: Robin LEI
 * @Date: 2026-02-05 15:32:51
 * @FilePath: \ONE-AI\app\serve\src\create_agent.ts
 */
import { ChatOllama } from "@langchain/ollama";
import { createAgent, createMiddleware } from "langchain";
import { ToolMessage, HumanMessage, AIMessage, BaseMessage, SystemMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph"; // 必须引入，用于定义 UI 输入框
import { tools } from "./embeddings/tool.js";
import { getAgentPrompt } from "./prompts/loader.js";
import { getConfig } from "./config/env.js";
import { z } from "zod";
import { MemorySaver } from "@langchain/langgraph"
const config = getConfig();

// 1. 使用 Zod 定义 Schema (这是 createAgent 最喜欢的格式)
const AgentStateSchema = z.object({
    // messages 必须显式定义，否则 createAgent 会报错
    messages: z.array(z.any()).default([]),
    userName: z.string().default("访客"),
    summary: z.string().default(""),
    sessionId: z.string().optional(), // <--- 添加这一行
});

// 2. 初始化 LLM
const llm = new ChatOllama({
    model: config.ollama.model,
    baseUrl: config.ollama.baseUrl,
    temperature: 0,
    repeatPenalty: config.ollama.repeatPenalty,
    numPredict: config.ollama.numPredict,
});

/**
 * 生产级：全功能集成中间件
 */
const allInOneMiddleware = createMiddleware({
    name: "ProductionAgentManager",

    // --- 1. 消息摘要与上下文清理 ---
    beforeAgent: {
        hook: async (state: any) => {
            // 兼容性处理：防止 LangGraph Studio 传入的 state 为空
            let { messages = [], summary = "" } = state;

            if (messages.length > 10) {
                console.log("检测到上下文过长，正在调用 LLM 压缩历史...");
                const toSummarize = messages.slice(0, -5);
                const historyText = toSummarize.map((m: any) => `${m._getType()}: ${m.content}`).join("\n");
                const summaryResponse = await llm.invoke([
                    new HumanMessage(`请简要总结以下对话要点：\n${historyText}`)
                ]);
                const newSummary = summaryResponse.content;
                return {
                    ...state,
                    messages: messages.slice(-5),
                    summary: summary ? `${summary}\n${newSummary}` : newSummary
                };
            }
            return state;
        }
    },

    // --- 2. 动态提示词与隐私脱敏 ---
    beforeModel: {
        hook: async (state: any, config: any) => {
            const { messages, summary } = state;
            const lastMsg = messages[messages.length - 1];
            // 1. 数据脱敏
            if (lastMsg instanceof HumanMessage && typeof lastMsg.content === "string") {
                lastMsg.content = lastMsg.content.replace(/1\d{10}/g, "[PHONE]");
            }

            // 2. 获取基础模板 (这里把 getAgentPrompt 拿回来)
            let dynamicPrompt = getAgentPrompt({
                currentTime: new Date().toLocaleString(),
                userName:lastMsg.userName
            });

            // 3. 拼接业务 SOP 指令 (保持一致性)
            dynamicPrompt += `
            ## 严格指令
            1. 当你需要查询信息时，**必须直接调用工具**，严禁输出任何查询过程中的废话。
            2. 如果 'query_memory' 返回 [MISSING_MEMORY]，必须立即调用 'serachTool'。
            3. 工具返回结果后，请直接整合信息回答用户。
            4. 请使用中文回答，哪怕结果是英文，也要翻译成中文。
            5. 如果搜索结果是英文，你必须先在脑中翻译，严禁直接输出英文内容。
            6.调用 'query_memory' 时，必须且仅能使用参数 'query'，例如：{"query": "王五的休息情况"}。
            7.严禁使用 'object'、'content' 等不存在的字段。
            `;
            if (summary) {
                dynamicPrompt += `\n\n[历史背景总结]: ${summary}`;
            }
            return { ...state, systemPrompt: dynamicPrompt };
        }
    },


    // // --- 3. 工具调用重试 ---
    // wrapToolCall: async (input, next) => {
    //     const MAX_RETRIES = 2;
    //     let lastError: any;
    //     for (let i = 0; i <= MAX_RETRIES; i++) {
    //         try {
    //             return await next(input);
    //         } catch (err) {
    //             lastError = err;
    //             if (i === MAX_RETRIES) throw err;
    //             console.warn(`工具 ${input.tool} 重试中 (${i + 1})...`);
    //             await new Promise(r => setTimeout(r, 1000));
    //         }
    //     }
    //     throw lastError;
    // },

    // --- 4. 模型调用次数限制 ---
    wrapModelCall: async (input, next) => {
        const currentDepth = (input as any).state?.loopDepth || 0;
        if (currentDepth > 5) {
            throw new Error("检测到逻辑死循环：模型调用次数超限。");
        }
        return await next(input);
    }
});

/**
 * 3. 创建最终 Agent
 */
const checkpointer = new MemorySaver();
export const graph = createAgent({
    model: llm,
    tools,
    // 关键：将 Annotation 传入，这会让 Studio 自动生成 userName 和 summary 输入框
    // 注意：如果你的版本不支持 state 属性，请尝试改名为 schemas: [AgentState]
    stateSchema: AgentStateSchema,
    systemPrompt: `你是一个热心且知识渊博的智能管家，随时准备帮助用户解决各种问题。请以中文回答所有问题。`,
    middleware: [allInOneMiddleware],
    checkpointer: checkpointer
});

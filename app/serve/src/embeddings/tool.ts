/*
 * @Author: Robin LEI
 * @Date: 2025-12-24 11:32:15
 * @LastEditTime: 2025-12-24 16:43:24
 * @FilePath: \ONE-AI\app\serve\src\embeddings\tool.ts
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { addMessageToVectorStore, retrieveRelevantHistory } from "./mxbai-embed-large.js";
import { ToolNode } from "@langchain/langgraph/prebuilt";
const queryTool = tool(
    async ({ query }, config) => {
        const sessionId = config.configurable?.sessionId;
        console.log(`[Tool] 正在检索知识库: ${query}`);
        const result = await retrieveRelevantHistory(query, sessionId);
        return result === "无相关背景信息" ? "未找到相关记忆。请停止检索并基于已知信息回答。" : result;
    },
    {
        name: "query_memory",
        description: "查询用户偏好或历史背景。如果搜不到，不要重复调用。",
        schema: z.object({ query: z.string().describe("检索关键词") }),
    }
);

// 工具 B：自主存储（Agent 决定什么重要才存）
const saveTool = tool(
    async ({ content }, config) => {
        const sessionId = config.configurable?.sessionId;
        console.log(`[Tool] 正在存入重要记忆: ${content}`);
        await addMessageToVectorStore(sessionId, "Agent自主提取", content);
        return "信息已成功存入长久记忆库。";
    },
    {
        name: "save_memory",
        description: "【必须调用】当用户自我介绍、提到他人姓名、职业、师生关系或关键背景事实时，必须使用此工具。输入参数 content 必须包含提取到的所有事实。",
        schema: z.object({ content: z.string().describe("提取到的核心事实，如：用户李明(教师)，朋友王阳(学生/李明的学生)") }),
    }
);

const tools = [queryTool, saveTool];
const toolNode = new ToolNode(tools);
export { tools, toolNode };
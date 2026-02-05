/*
 * @Author: Robin LEI
 * @Description: 优化后的工具集 - 增强了对小模型的指令引导与错误处理
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
// 假设这些路径是正确的
import { addMessageToVectorStore, retrieveRelevantHistory } from "./mxbai-embed-large.js";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { TavilySearch } from "@langchain/tavily";

/**
 * 工具 A：本地记忆检索 (Optimized)
 * 返回精简明确的信号 [MISSING_MEMORY]
 */
const queryTool = tool(
    async ({ query }, config) => {
        const sessionId = config.configurable?.sessionId;
        try {
            const result = await retrieveRelevantHistory(query, sessionId);
            console.log("【queryTool 检索结果】", result);

            // 关键优化：只返回一个明确、简短的信号
            if (!result || result.includes("无相关背景信息") || result.includes("出错")) {
                return "[MISSING_MEMORY]";
            }
            return `找到相关历史背景：\n${result}`;
        } catch (error) {
            return "[MISSING_MEMORY]"; // 捕获错误时也返回缺失信号
        }
    },
    {
        name: "query_memory",
        description: "首选工具。查询用户的历史偏好或背景。如果返回 [MISSING_MEMORY]，必须立即改用 'serachTool' 联网搜索。",
        schema: z.object({ query: z.string().describe("检索关键词，如'用户的名字'、'昨天的聊天内容'") }),
    }
);

/**
 * 工具 B：长久记忆存储
 */
const saveTool = tool(
    async ({ content }, config) => {
        const sessionId = config.configurable?.sessionId;
        await addMessageToVectorStore(sessionId, "Agent自主提取", content);
        return "【系统提示】信息已成功持久化存储。";
    },
    {
        name: "save_memory",
        description: "记忆存储工具。当用户提到关键事实（如：姓名、偏好）时，必须调用此工具进行记录。",
        schema: z.object({
            content: z.string().describe("需要存储的核心事实陈述，建议格式：'用户：[姓名]，特征：[事实]'")
        }),
    }
);


/**
 * 工具 C：联网搜索 (Tavily) (Optimized)
 * 增加对“无结果”的明确信号返回
 */
const serachTool = tool(
    async ({ query }) => {
        try {
            // 请确保您的环境变量 TAVILY_API_KEY 已配置
            const searchEngine = new TavilySearch({
                tavilyApiKey: process.env.TAVILY_API_KEY || '',
                maxResults: 3,
                includeAnswer: true,
            });

            const { results } = await searchEngine.invoke({ query });
            console.log("【serachTool 搜索结果】", results);
            let finalOutput = "";
            if (typeof results === "string") {
                finalOutput = results;
            } else if (Array.isArray(results)) {
                finalOutput = results
                    .map((r: any) => `[标题]: ${r.title}\n[内容]: ${r.content}\n[来源]: ${r.url}`)
                    .join("\n\n");
            }

            // 如果搜索结果为空，返回一个明确信号
            if (!finalOutput || finalOutput.includes("没有找到任何结果")) {
                return "[SEARCH_NO_RESULT]";
            }

            return finalOutput;
        } catch (error) {
            console.error("Tavily Error:", error);
            // API 连接失败时也返回明确信号
            return "[API_ERROR]";
        }
    },
    {
        name: "serachTool",
        description: "联网检索工具。用于查询实时新闻、百科知识。如果返回 [SEARCH_NO_RESULT] 或 [API_ERROR]，Agent 应礼貌告知用户并结束。",
        schema: z.object({
            query: z.string().describe("搜索关键词")
        }),
    }
);

const tools = [queryTool, saveTool, serachTool];
const toolNode = new ToolNode(tools);

export { tools, toolNode };

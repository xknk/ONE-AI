/*
 * @Author: Robin LEI
 * @Date: 2025-12-17 08:39:51
 * @LastEditTime: 2025-12-22 14:59:55
 * @FilePath: \ONE-AI\app\serve\src\embeddings\mxbai-embed-large.ts
 */

import { OllamaEmbeddings } from "@langchain/ollama";
import { InMemoryChatMessageHistory, BaseChatMessageHistory } from "@langchain/core/chat_history";
import { VectorStoreRetriever, SaveableVectorStore, VectorStore } from "@langchain/core/vectorstores";
// 1. 引入 PGVector 和 pg 驱动
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
const embeddingModel = new OllamaEmbeddings({
    model: 'mxbai-embed-large',
    baseUrl: "http://127.0.0.1:11434", // Ollama 服务地址（默认端口 11434，可省略）
    truncate: true, // 超长文本自动截断
})

// 2. 配置 PostgreSQL 连接参数 (对应你的 docker-compose 配置)
const pgConfig = {
    host: "127.0.0.1",
    port: 5432,
    user: "fanxiaosi",
    password: "f15130026310.",
    database: "One-AI-DB",
};

// ====================== 2. 会话存储类型定义 ======================
export interface SessionStore {
    chatHistory: BaseChatMessageHistory; // 原始对话历史（用于消息记录）
    vectorStore: VectorStore; // 对话历史向量库（用于RAG检索）
    retriever: VectorStoreRetriever; // 向量检索器（语义检索核心）
}
// ====================== 3. 全局会话存储（隔离不同会话） ======================
const sessionStores: Record<string, SessionStore> = {};

// ====================== 4. 核心工具函数（对外导出） ======================
/**
 * 获取会话专属的「对话历史 + 向量库 + 检索器」
 * @param sessionId 会话ID
 * @returns 会话专属存储实例
 */
export const getSessionStore = async (sessionId: string): Promise<SessionStore> => {
    if (!sessionStores[sessionId]) {
        // 初始化：空对话历史 + 空向量库 + 检索器（取最相似的3条）
        const chatHistory = new InMemoryChatMessageHistory();
        // 3. 初始化 PGVectorStore 代替 MemoryVectorStore
        const vectorStore = await PGVectorStore.initialize(embeddingModel, {
            postgresConnectionOptions: pgConfig,
            tableName: "test_langchain_embeddings", // 插件会自动创建这张表
            columns: {
                idColumnName: "id",
                vectorColumnName: "embedding",
                contentColumnName: "text",
                metadataColumnName: "metadata",
            },
        });
        // 4. 配置检索器，加入针对 sessionId 的过滤
        // 注意：这样能保证不同 sessionId 之间的数据隔离
        const retriever = vectorStore.asRetriever({
            searchType: "mmr",
            searchKwargs: {
                fetchK: 20,    // 先捞出 20 条最相似的
                lambda: 0.7,   // 相似度与多样性的平衡
            },
            k: 3,
            filter: { sessionId }
        });
        sessionStores[sessionId] = { chatHistory, vectorStore, retriever };
    }
    return sessionStores[sessionId];
};
/**
 * 把单轮对话存入向量库（批量嵌入核心逻辑）
 * @param sessionId 会话ID
 * @param humanInput 用户输入
 * @param aiResponse AI回复（可选，首次存储仅用户输入）
 */
export const addMessageToVectorStore = async (
    sessionId: string,
    humanInput: string,
    aiResponse?: string
) => {
    // 清洗 AI 回复：移除 <think> 标签及其内容，避免干扰向量检索
    const cleanAIResponse = aiResponse?.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    const { vectorStore } = await getSessionStore(sessionId);
    // 构造对话文本（便于LLM理解语义）
    const messageText = cleanAIResponse
        ? `用户：${humanInput}\n助手：${cleanAIResponse}`
        : `用户：${humanInput}`;

    // 批量嵌入并存储（单条也用批量接口，便于扩展多轮）
    await vectorStore.addDocuments([
        {
            pageContent: messageText,
            metadata: { sessionId, timestamp: Date.now() }
        },
    ]);
};

/**
 * 检索与用户输入语义相似的对话历史（RAG核心）
 * @param userInput 用户当前输入
 * @param sessionId 会话ID
 * @returns 格式化后的相似历史文本（仅文本，不传向量）
 */
export const retrieveRelevantHistory = async (
    userInput: string,
    sessionId: string
) => {
    const { retriever } = await getSessionStore(sessionId);
    // 基于用户输入的嵌入向量，检索相似历史
    const relevantDocs = await retriever.invoke(userInput);
    // 格式化检索结果（纯文本，供LLM使用）
    return relevantDocs.length > 0
        ? relevantDocs.map(doc => doc.pageContent).join("\n\n")
        : "无相关对话历史";
};

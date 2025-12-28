/*
 * @Author: Robin LEI
 * @Date: 2025-12-17 12:49:51
 * @LastEditTime: 2025-12-24 14:51:36
 * @FilePath: \ONE-AI\app\serve\src\embeddings\mxbai-embed-large.ts
 */
import { OllamaEmbeddings } from "@langchain/ollama";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";

// 1. 全局配置与模型实例
const embeddingModel = new OllamaEmbeddings({
    model: 'mxbai-embed-large',
    baseUrl: "http://127.0.0.1:11434",
    truncate: true,
});

const pgConfig = {
    host: "127.0.0.1",
    port: 5432,
    user: "fanxiaosi",
    password: "f15130026310.",
    database: "One-AI-DB",
};

// 2. 单例模式管理 VectorStore (避免为每个 session 创建重复的连接池)
let globalVectorStore: PGVectorStore | null = null;
export const getVectorStore = async (): Promise<PGVectorStore> => {
    if (!globalVectorStore) {
        globalVectorStore = await PGVectorStore.initialize(embeddingModel, {
            postgresConnectionOptions: pgConfig,
            tableName: "test_langchain_embeddings",
            columns: {
                idColumnName: "id",
                vectorColumnName: "embedding",
                contentColumnName: "text",
                metadataColumnName: "metadata",
            },
        });
    }
    return globalVectorStore;
};

/**
 * 把单轮对话存入向量库
 */
export const addMessageToVectorStore = async (
    sessionId: string,
    humanInput: string,
    aiResponse?: string
) => {
    // 【关键修复】：确保存入的是清洗后的内容，移除 <think> 标签及其内容
    const cleanAIResponse = aiResponse?.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    const vectorStore = await getVectorStore();

    // 构造最终存入向量库的文本
    const messageText = cleanAIResponse
        ? `用户：${humanInput}\n助手：${cleanAIResponse}`
        : `用户：${humanInput}`;

    await vectorStore.addDocuments([
        {
            pageContent: messageText,
            metadata: {
                sessionId,
                timestamp: Date.now(),
                type: aiResponse ? "qa_pair" : "user_query"
            }
        },
    ]);
};

/**
 * 检索与用户输入语义相似的对话历史
 */
export const retrieveRelevantHistory = async (
    userInput: string,
    sessionId: string
) => {
    const vectorStore = await getVectorStore();

    // 配置检索器：针对 sessionId 物理隔离，并使用 MMR 减少冗余
    const retriever = vectorStore.asRetriever({
        searchType: "similarity", // 使用相似度搜索 （也可以尝试 "mmr"）
        // searchKwargs: {
        //     fetchK: 20,
        //     lambda: 0.7,
        // },
        k: 2, // 小模型 1.5B 建议设为 3，多则乱
        filter: { sessionId }, // 确保只搜当前用户/当前会话的知识
    });
    const relevantDocs = await retriever.invoke(userInput);
    const context = relevantDocs.length > 0
        ? relevantDocs.map(doc => {
            return doc.pageContent
        }).join("\n\n")
        : "无相关背景信息";
    // 强制截断，防止撑爆 LLM 上下文
    return context.length > 800  ? context.substring(0, 800) + "..." : context;

};
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

// 1. 定义严谨的“数据模具” (使用 Zod)
const ResumeSchema = z.object({
  name: z.string().describe("求职者姓名"),
  experienceYears: z.number().describe("总工作年限"),
  skills: z.array(z.string()).describe("核心技术栈列表"),
  isQualified: z.boolean().describe("是否符合高级工程师岗位要求")
});

const model = new ChatOpenAI({ modelName: "gpt-4o" });

// 2. 绑定结构化输出
const structuredModel = model.withStructuredOutput(ResumeSchema);

// 3. 调用（场景：后台自动处理任务）
const result = await structuredModel.invoke(
  "张三，5年开发经验，精通 React 和 Node.js，曾就职于大厂。"
);

// 核心优势：result 现在是一个纯粹的 JS 对象，可以直接 result.name 访问
console.log(`入库成功：${result.name}, 匹配度：${result.isQualified}`);

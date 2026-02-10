/*
 * @Author: Robin LEI
 * @Date: 2026-02-05 16:39:13
 * @LastEditTime: 2026-02-05 16:39:24
 * @FilePath: \ONE-AI\app\serve\src\需求\toolDemo.ts
 */
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

// 1. 定义极其严格的 Schema，帮助模型理解每个参数的约束
const BookingSchema = z.object({
  destination: z.string().describe("目的地城市，如 '北京'"),
  travelDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("出发日期，格式 YYYY-MM-DD"),
  cabinClass: z.enum(["economy", "business", "first"]).describe("舱位等级"),
  reason: z.string().min(5).describe("出差事由（至少5个字）"),
});

type BookingInput = z.infer<typeof BookingSchema>;

export class FlightBookingTool extends StructuredTool {
  name = "book_flight";
  description = "企业差旅订票工具。仅当用户明确提出要订机票，并提供了目的地、日期和事由时使用。";
  schema = BookingSchema;

  // 模拟一个内部权限服务
  private checkPermission(userRole: string, cabin: string): boolean {
    if (userRole === "intern" && cabin !== "economy") return false;
    return true;
  }

  // 核心逻辑执行
  async _call(
    { destination, travelDate, cabinClass, reason }: BookingInput, 
    _runManager?: any, 
    config?: any
  ): Promise<string> {
    // A. 身份识别（通过自定义 context 传入）
    const userRole = config?.configurable?.userRole || "intern";
    const userName = config?.configurable?.userName || "访客";

    // B. 业务逻辑拦截 (不仅仅是查数据库，还包含策略判断)
    if (!this.checkPermission(userRole, cabinClass)) {
      return `【订票失败】对不起 ${userName}，根据公司差旅政策，您的职位 (${userRole}) 不允许预订 ${cabinClass}。请尝试预订经济舱。`;
    }

    try {
      // C. 模拟调用第三方接口（如携程、飞猪 API）
      console.log(`正在为 ${userName} 预订去 ${destination} 的机票...`);
      
      // D. 结果脱敏处理：只给 AI 返回确认码，不给详细的后台 ID
      const mockTicketId = "TK-" + Math.random().toString(36).substr(2, 9);
      
      return `【预订成功】已为您预订 ${travelDate} 前往 ${destination} 的 ${cabinClass} 机票。
      事由：${reason}
      确认单号：${mockTicketId}
      请在企业后台查看详细支付信息。`;
      
    } catch (error) {
      return "【系统错误】订票服务暂时无法连接，请稍后再试。";
    }
  }
}

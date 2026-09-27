import { expect, type Page } from '@playwright/test';
import { ROOT_URL } from './test-env';

/**
 * E2E 的共用探针（`views.spec.ts` 与 `tablet.spec.ts` 共用，#31）。
 *
 * **载体是模块而不是 spec 文件**：Playwright 明令 spec 之间不得互相 import
 * （`test file "x.spec.ts" should not import test file "y.spec.ts"`），而 #31 的
 * Testing Decisions 又明写「`bookingSnapshot()` 直接复用、不另写一份」——放进一个
 * 非 spec 的模块，两条都满足。
 *
 * 只放**与断言对象直接相关、且两处口径必须逐字相同**的取数/探测；`.spec.ts` 里的
 * 用例编排（清场、定餐流程）留在各自的 spec 里。
 */

/** 服务端下发的餐槽（只取断言用得到的字段） */
export interface SlotJson {
  id: string;
  date: string;
  meal: 'lunch' | 'dinner';
  status: 'undecided' | 'decided';
  menu: {
    dishes: { recipeId: string; name: string; keepLeftover: boolean }[];
    diners: { memberId: string; name: string }[];
    leftoverSlotId: string | null;
  } | null;
  /** 晚餐「吃剩的」的来源（服务端推导：同日午餐已定且标了留量） */
  leftoverSource: { slotId: string; dishes: { recipeId: string; name: string }[] } | null;
  /** 本餐份量（服务端现算；留量那一餐的逐菜上浮读数在里面） */
  portion: { uplift: number; dishes: { recipeId: string; uplift: number }[] } | null;
}

export interface HistoryJson {
  type: string;
  source: string;
  leftoverSlotId: string | null;
  llm: { model: string; promptVersion: string; degraded: boolean } | null;
  diners: { memberId: string }[];
}

export interface BookingSnapshot {
  status: string;
  dishes: { recipeId: string; keepLeftover: boolean }[];
  diners: string[];
  /** 菜单上的「吃剩的」引用（#22）：普通菜单 / 推荐那一套都是 null */
  leftoverOf: string | null;
  /** 本餐逐菜的上浮系数（服务端现算；这一餐读的是被引用那一餐多做的那一份） */
  uplift: number[];
  lastEvent: string;
  lastSource: string;
  /** 末条留痕的「吃剩的」引用（事件流要能回答「为什么这顿没新采购」） */
  lastLeftoverOf: string | null;
  /** 留痕里的 LLM 元数据：只取**语义**字段。`latencyMs` 刻意不进对照——它是真实耗时，
   *  同一条路重跑也会 0ms/1ms 地跳，拿它比会把「语义一致」变成随机红。 */
  lastLlm: { model: string; promptVersion: string; degraded: boolean } | null;
}

/** 服务端此刻的真实状态：状态 + 菜单（含每道菜的留量）+ 末条留痕（类型/source/LLM 元数据） */
export async function bookingSnapshot(page: Page, slotId: string): Promise<BookingSnapshot> {
  const response = await page.request.get(`${ROOT_URL}/api/slots/${slotId}`);
  const { slot, history } = (await response.json()) as { slot: SlotJson; history: HistoryJson[] };
  const last = history.at(-1);
  return {
    status: slot.status,
    dishes: (slot.menu?.dishes ?? []).map((dish) => ({ recipeId: dish.recipeId, keepLeftover: dish.keepLeftover })),
    diners: (slot.menu?.diners ?? []).map((diner) => diner.memberId),
    leftoverOf: slot.menu?.leftoverSlotId ?? null,
    uplift: (slot.portion?.dishes ?? []).map((dish) => dish.uplift),
    lastEvent: last?.type ?? '',
    lastSource: last?.source ?? '',
    lastLeftoverOf: last?.leftoverSlotId ?? null,
    lastLlm: last?.llm
      ? { model: last.llm.model, promptVersion: last.llm.promptVersion, degraded: last.llm.degraded }
      : null,
  };
}

/** 清场：窗口内已定的餐槽全取消（每条用例都要一张干净的表） */
export async function clearDecidedSlots(page: Page): Promise<void> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=14`);
  const { slots } = (await response.json()) as { slots: SlotJson[] };
  for (const slot of slots.filter((item) => item.status === 'decided')) {
    await page.request.delete(`${ROOT_URL}/api/slots/${slot.id}`);
  }
}

/** 窗口内的餐槽（日期×餐次顺序） */
export async function listSlots(page: Page, days: number): Promise<SlotJson[]> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=${days}`);
  expect(response.ok(), `餐槽列表没要回来：HTTP ${response.status()}`).toBe(true);
  return ((await response.json()) as { slots: SlotJson[] }).slots;
}

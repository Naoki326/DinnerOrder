/**
 * 食材的展示小工具（issue #34、#38）。
 *
 * 修一个既有渲染毛病：给食材挂上**与规范名同名**的别名时，界面会显示成「莴笋（莴笋）」。
 * 种子库里已经有 5 条这种数据（黄芪、麻酱、鸡胸肉、板栗、柱侯酱），而字典页要渲染**完整别名列表**，
 * 正是第一个会大面积撞上它的地方——所以把判据收在这一处，两处调用点共用。
 *
 * #38 加了 `formatNutrition`：字典页的详情卡与每餐营养弹层都要把每 100 g 读数写成一位小数，
 * 两处各写一份就会漂（同一个数在两屏上长得不一样）。
 */

/**
 * 展示用的别名：**去掉与规范名相同的那些**。
 *
 * 为什么同名别名会出现而不是直接禁止：别名是「家人怎么说」，规范名是「字典怎么叫」——
 * 两者同字是合理的（录入时顺手把规范名也存成了别名），只是渲染时不该重复一遍。
 */
export function aliasesForDisplay(ingredient: { name: string; aliases: string[] }): string[] {
  return ingredient.aliases.filter((alias) => alias !== ingredient.name);
}

/** 列表里那条小字提示：第一个真别名（与规范名不同的），没有就是 undefined */
export function primaryAlias(ingredient: { name: string; aliases: string[] }): string | undefined {
  return aliasesForDisplay(ingredient)[0];
}

/**
 * 别名输入框：逗号 / 顿号 / 空白都当分隔符，trim 后去空。
 *
 * 放在这里而不是两处各写一份：录入表单**两处各渲染**（字典页与菜谱编辑器就地新建，spec #33
 * 有意认可那份**表单 JSX** 的重复），但这是**纯函数**，两处必须同一口径——重复一份就会默默漂移
 * （重复的注释自己写着「与另一处同一口径」，却没有任何机制保证）。
 */
export function parseAliases(text: string): string[] {
  return text
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * 营养读数的人话：一位小数就够（营养是估算值/平均值，展示更多位是假精度）；整数时不带小数点。
 *
 * 与 `NutritionSheet` 的 `format` 同一个口径——两处各写一份就会漂（同一个数在两屏上不一样）。
 */
export function formatNutrition(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

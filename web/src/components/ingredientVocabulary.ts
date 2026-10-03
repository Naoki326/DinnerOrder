/**
 * 食材的展示小工具（issue #34）。
 *
 * 修一个既有渲染毛病：给食材挂上**与规范名同名**的别名时，界面会显示成「莴笋（莴笋）」。
 * 种子库里已经有 5 条这种数据（黄芪、麻酱、鸡胸肉、板栗、柱侯酱），而字典页要渲染**完整别名列表**，
 * 正是第一个会大面积撞上它的地方——所以把判据收在这一处，两处调用点共用。
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

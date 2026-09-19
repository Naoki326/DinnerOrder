import { describe, expect, it } from 'vitest';
import { RECOMMENDATION_JSON_SCHEMA, checkSelection, positionOf } from './recommendation-schema.js';
import type { RecipeKind, RecommendationStructure } from '../wire-types.js';

/**
 * LLM 出参校验（ADR-0001：输出只能是从候选池里挑的 id）。
 * 这一层是幻觉的闸门——端点说它「按 schema 验证过」和「我们确实检查过」是两件事。
 */
const POOL: { id: string; kind: RecipeKind }[] = [
  { id: 'fanqiechaodan', kind: 'veg' },
  { id: 'suanrongcaixin', kind: 'veg' },
  { id: 'hongshaopaigu', kind: 'meat' },
  { id: 'kelejichi', kind: 'meat' },
  { id: 'dongguapaigutang', kind: 'soup_meat' },
  { id: 'fanqiedanhuatang', kind: 'soup_veg' },
];

const STRUCTURE: RecommendationStructure = { adults: 2, children: 0, meat: 2, veg: 1, soup: 1 };

function text(dishes: { recipeId: string; reason: string }[]): string {
  return JSON.stringify({ dishes });
}

describe('荤素位归一', () => {
  it('soup_meat 与 soup_veg 都归汤位（汤分荤素只为忌口筛选）', () => {
    expect(positionOf('meat')).toBe('meat');
    expect(positionOf('veg')).toBe('veg');
    expect(positionOf('soup_meat')).toBe('soup');
    expect(positionOf('soup_veg')).toBe('soup');
  });
});

describe('LLM 挑选校验', () => {
  it('合法挑选通过：池内的菜 + 结构配满', () => {
    const check = checkSelection(
      text([
        { recipeId: 'hongshaopaigu', reason: '家里都爱吃' },
        { recipeId: 'kelejichi', reason: '小孩喜欢' },
        { recipeId: 'fanqiechaodan', reason: '清淡' },
        { recipeId: 'dongguapaigutang', reason: '夏天喝汤' },
      ]),
      POOL,
      STRUCTURE,
    );
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.dishes).toHaveLength(4);
  });

  it('池外的菜（幻觉）被拦下，并把 id 说进原因里', () => {
    const check = checkSelection(
      text([{ recipeId: 'mianfeidewucan', reason: '我编的' }]),
      POOL,
      STRUCTURE,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain('mianfeidewucan');
  });

  it('同一道菜选两次被拦下', () => {
    const check = checkSelection(
      text([
        { recipeId: 'fanqiechaodan', reason: 'a' },
        { recipeId: 'fanqiechaodan', reason: 'b' },
      ]),
      POOL,
      STRUCTURE,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain('两次');
  });

  it('结构不符被拦下，且原因里带实际与期望的对比', () => {
    const check = checkSelection(text([{ recipeId: 'fanqiechaodan', reason: '一道素菜' }]), POOL, STRUCTURE);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain('结构不符');
      expect(check.reason).toContain('荤 2');
    }
  });

  it('不是 JSON / 空对象 / 缺字段都判失败并给出可读原因', () => {
    const notJson = checkSelection('我推荐番茄炒蛋。', POOL, STRUCTURE);
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.reason).toContain('合法 JSON');

    expect(checkSelection('{"oops":true}', POOL, STRUCTURE).ok).toBe(false);
    expect(checkSelection('{"dishes":[]}', POOL, STRUCTURE).ok).toBe(false);
    expect(checkSelection('{"dishes":[{"recipeId":"fanqiechaodan"}]}', POOL, STRUCTURE).ok).toBe(false);
  });

  it('容忍 markdown 代码块包裹（json_object 档的常见走样）', () => {
    const fenced = '```json\n' + text([
      { recipeId: 'hongshaopaigu', reason: 'a' },
      { recipeId: 'kelejichi', reason: 'b' },
      { recipeId: 'fanqiechaodan', reason: 'c' },
      { recipeId: 'fanqiedanhuatang', reason: 'd' },
    ]) + '\n```';
    expect(checkSelection(fenced, POOL, STRUCTURE).ok).toBe(true);
  });

  it('前后有解释文字也还能取出 JSON（只清洗这一层，形状交给 Zod）', () => {
    const noisy = `好的，这是推荐：${
      text([
        { recipeId: 'hongshaopaigu', reason: 'a' },
        { recipeId: 'kelejichi', reason: 'b' },
        { recipeId: 'fanqiechaodan', reason: 'c' },
        { recipeId: 'dongguapaigutang', reason: 'd' },
      ])
    } 希望合适。`;
    expect(checkSelection(noisy, POOL, STRUCTURE).ok).toBe(true);
  });

  it('给端点的 JSON Schema 与本地 Zod 对齐（键名一致、必填一致）', () => {
    const schema = RECOMMENDATION_JSON_SCHEMA as {
      required: string[];
      properties: { dishes: { items: { required: string[]; properties: Record<string, unknown> } } };
    };
    expect(schema.required).toEqual(['dishes']);
    expect(schema.properties.dishes.items.required).toEqual(['recipeId', 'reason']);
    expect(Object.keys(schema.properties.dishes.items.properties).sort()).toEqual(['reason', 'recipeId']);
  });
});

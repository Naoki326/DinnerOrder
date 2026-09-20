import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 迁移 013 的**迁移纪律**（食材字典补录「扁平 + 三件套」，issue #28）。
 *
 * 与 schema-008.test.ts 同一口径：只断言外部可见行为，且只留**没有写入口能触及**的那几条。
 * 「粗名归得上」「忌口向上传播」「清单分列」这些行为由 `domain/library.test.ts`、
 * `api/recommendations.test.ts`、`api/grocery.test.ts` 走真实路径覆盖，不在此重复。
 *
 * 这里钉的是三条**迁移自身的纪律**（照 008 的先例）：
 *   1. **只种自己的行**：迁移里只加字典行/指针/别名，**不碰既有菜谱行**——
 *      生数据纪律（`migrations/README.md`：迁移只种规则资产与字典）；
 *   2. **不建 parent_id 层级**：本票明确否决了层级模型（部位/品种两维之分），
 *      所以字典表上不能冒出 parent_id/层级列——那是将来要另立 ADR 才能做的事；
 *   3. **「含」指针的单向性与基础类归属**：只有「细类 → 基础类」一个方向。
 */
describe('013 迁移的字典补录纪律', () => {
  it('只加字典行与指针，一条既有菜谱行都不碰（生数据纪律）', () => {
    harness = createTestHarness();

    // 004 的种子草稿与 002 的家庭菜谱都原样在（本迁移不改它们任何一个字段）
    const huiguorou = harness.db
      .prepare("SELECT name, status, source, kind FROM recipes WHERE id = 'huiguorou'")
      .get() as { name: string; status: string; source: string; kind: string };
    expect(huiguorou).toEqual({
      name: '回锅肉',
      status: 'draft',
      source: 'howtocook',
      kind: 'meat',
    });
    // 家庭菜谱的克数一个没动（红烧排骨 150 g 猪排骨，002 的种子）
    const ribs = harness.db
      .prepare("SELECT adult_grams FROM recipe_ingredients WHERE recipe_id = 'hongshaopaigu' AND ingredient_id = 'pork_ribs'")
      .get() as { adult_grams: number };
    expect(ribs.adult_grams).toBe(150);
    // 既有的「含」指针没被改（002 的蚝油→贝类、豆瓣酱→辣椒）
    const oyster = harness.db
      .prepare("SELECT COUNT(*) AS n FROM ingredient_contains WHERE ingredient_id = 'oyster_sauce' AND contains_id = 'shellfish'")
      .get() as { n: number };
    expect(oyster.n).toBe(1);
  });

  it('没有引入 parent_id 层级模型（本票明确否决；将来要做得另立 ADR）', () => {
    harness = createTestHarness();

    const columns = harness.db.prepare('PRAGMA table_info(ingredients)').all() as { name: string }[];
    expect(columns.map((column) => column.name).sort()).toEqual(['id', 'name']);
    // 也没有别的层级表（sibling / subclass / variety 之类）
    const tables = (harness.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (row) => row.name,
    );
    expect(tables.filter((name) => /hierarch|parent|subclass|variety|species/i.test(name))).toEqual([]);
  });

  it('「含」指针是单向的：细类指向基础类，基础类不指回细类', () => {
    harness = createTestHarness();

    const direct = (from: string): string[] =>
      (harness.db.prepare('SELECT contains_id FROM ingredient_contains WHERE ingredient_id = ?').all(from) as {
        contains_id: string;
      }[]).map((row) => row.contains_id);

    // 细类 → 基础类
    expect(direct('pork_ribs')).toContain('pork');
    expect(direct('pork_loin')).toContain('pork');
    expect(direct('pork_belly')).toContain('pork');
    expect(direct('pork_mince')).toContain('pork');
    expect(direct('chicken_legs')).toContain('chicken');
    expect(direct('chicken_wings')).toContain('chicken');
    expect(direct('sesame_seed')).toContain('sesame');
    expect(direct('black_sesame')).toContain('sesame');
    expect(direct('sesame_oil')).toContain('sesame');
    expect(direct('rice')).toContain('cooked_rice');
    expect(direct('garlic_powder')).toContain('garlic');
    expect(direct('ginger_powder')).toContain('ginger');
    // 反向：基础类不含细类（「忌猪排骨」不该把整头猪都排掉）
    expect(direct('pork')).not.toContain('pork_ribs');
    expect(direct('chicken')).not.toContain('chicken_legs');
    expect(direct('sesame')).not.toContain('sesame_seed');
  });

  it('新增的裸名条目与细粒度条目并存（不是替换关系：两条都在）', () => {
    harness = createTestHarness();

    const nameOf = (id: string): string | undefined =>
      (harness.db.prepare('SELECT name FROM ingredients WHERE id = ?').get(id) as { name: string } | undefined)?.name;

    expect(nameOf('pork')).toBe('猪肉');
    expect(nameOf('pork_ribs')).toBe('猪排骨');
    expect(nameOf('pork_loin')).toBe('猪梅花肉');
    expect(nameOf('sesame')).toBe('芝麻');
    expect(nameOf('sesame_seed')).toBe('白芝麻');
    expect(nameOf('cooked_rice')).toBe('米饭');
    expect(nameOf('rice')).toBe('大米');
  });

  it('别名全局唯一：本迁移没把别名撞到别的叫法上（撞了会静默改掉别人的归一）', () => {
    harness = createTestHarness();

    // 别名与别名不撞（PRIMARY KEY 钉死，这里是回归保险）
    const duplicates = harness.db
      .prepare('SELECT alias, COUNT(*) AS n FROM ingredient_aliases GROUP BY alias HAVING n > 1')
      .all() as { alias: string; n: number }[];
    expect(duplicates).toEqual([]);

    // 「某个规范名同时是别人的别名」是**既有状态**（16 条：干辣椒/扇贝/板栗/猪肝/生蚝…，
    // 那是 001/002/005 的粒度选择，不是本票引入的），所以这里只钉**本票新增的那些**
    // 没有把这个数变大——新增别名与规范名不能撞，否则同一个叫法在归一里会有两个去处。
    const newAliases = [
      '耗油', '柱候酱', '西蓝花', '肉', '鸡', '温水', '冷水', '凉水', '沸水', '矿泉水',
      '葱结', '芝麻酱', '肉蟹', '野山椒', '大排', '鸭肉', '冷饭', '味素', '盐巴', '黑椒粉',
      '菜椒', '蒸鱼豉油', '猪通脊肉', '鸡全翅', '泡打粉', '粉丝', '红油瓣酱', '羊排', '羊腩',
    ];
    const clash = newAliases.filter((alias) =>
      harness.db.prepare('SELECT 1 FROM ingredients WHERE name = ?').get(alias),
    );
    expect(clash).toEqual([]);
  });

  it('裸名基础条目没有把品种（黑猪/土猪）建进字典（品种不入库是本票的第三条）', () => {
    harness = createTestHarness();

    const names = (harness.db.prepare('SELECT name FROM ingredients').all() as { name: string }[]).map((row) => row.name);
    for (const variety of ['黑猪', '土猪', '野猪', '白羽鸡', '土鸡（品种）']) {
      expect(names, `${variety} 是品种，不该进字典`).not.toContain(variety);
    }
  });
});

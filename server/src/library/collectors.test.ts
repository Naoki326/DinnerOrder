import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isSeasoning,
  isVagueQuantity,
  kindFrom,
  llmGeneratedDraft,
  parseGrams,
  parseHowToCook,
  parseXiachufangDetail,
  parseXiachufangHtml,
  xiachufangDraft,
} from './collectors.js';

/**
 * 采集器的单测：**吃本地 fixture、不碰网**。
 *
 * 这是本票最重要的一条测试纪律——「导入器对不对」与「今天能不能连上 GitHub / 下厨房」
 * 必须是两件独立的事。夹具是从真实数据源抓下来的原文（HowToCook 的两篇 markdown、
 * 下厨房的一张热榜页与一张详情页），所以解析口径是对着真形状验的，不是对着想象的形状。
 */

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');

describe('份量解析（不猜：没有明确克数就留 null 等 LLM 重标）', () => {
  it('明确的重量单位换算成克（斤/两/公斤/克）', () => {
    expect(parseGrams('200g')).toBe(200);
    expect(parseGrams('约 3~4 斤')).toBe(2000);
    expect(parseGrams('2 两')).toBe(100);
    expect(parseGrams('1 公斤')).toBe(1000);
    expect(parseGrams('250 克')).toBe(250);
  });

  it('没有重量单位的一律不换算（「3 瓣蒜」不是 15g——那是重标的活）', () => {
    expect(parseGrams('3 瓣')).toBeUndefined();
    expect(parseGrams('一个')).toBeUndefined();
    expect(parseGrams('两勺')).toBeUndefined();
    expect(parseGrams('适量')).toBeUndefined();
  });

  it('模糊份量有自己的字面（报告里要留证据）', () => {
    expect(isVagueQuantity('适量')).toBe(true);
    expect(isVagueQuantity('少许')).toBe(true);
    expect(isVagueQuantity('200g')).toBe(false);
  });

  it('调料/香料判 fixed（一锅就这么多，不随人数放大——与 002 的种子同一口径）', () => {
    expect(isSeasoning('盐')).toBe(true);
    expect(isSeasoning('生抽')).toBe(true);
    expect(isSeasoning('大蒜')).toBe(true);
    expect(isSeasoning('五花肉')).toBe(false);
  });
});

/**
 * 「份量在前」的倒装行（issue #29）。
 *
 * HowToCook 里有相当一批条目是倒装的（`10g 的干紫菜`、`两个鸡蛋`），而 `splitNameQuantity`
 * 原先**假定份量永远写在名字后面**：切点落在份量的起点，倒装行的切点就是 0，于是切出的名字是空串、
 * 整条被 `if (name === '' || quantity === '') continue` 丢掉。
 *
 * **损失是静默的**：菜照样入库，只是少几样食材——买菜清单跟着少买、份量合计少算。
 * 实测（对 HowToCook 全仓库 377 篇重放）：倒装丢弃 **54 行 / 21 道菜**，丢得最狠的是麻婆豆腐 10 行。
 *
 * 这一组用**真实原文夹具**（`howtocook-zicaidanhuatang.md` / `howtocook-mapodoufu.md`，
 * HowToCook 是 Unlicense 公有领域，与既有夹具同源）——形状是真数据，不是想象的。
 */
describe('倒装份量（issue #29）：`10g 的干紫菜` / `两个鸡蛋` 这类不再丢', () => {
  it('「份量 + 的 + 名字」：切出名字与份量，前导「的」不进名字', () => {
    const draft = parseHowToCook('dishes/soup/紫菜蛋花汤.md', fixture('howtocook-zicaidanhuatang.md'));
    expect(draft).toBeDefined();
    const byName = new Map(draft!.ingredients.map((item) => [item.name, item]));
    // 原文：`10g 的干紫菜（喜欢紫菜的可以多放些）` → 名字 `干紫菜`、份量 `10g`
    expect(byName.has('干紫菜')).toBe(true);
    expect(byName.get('干紫菜')?.adultGrams).toBe(10);
  });

  it('「数字 + 量词 + 名字」（无空格）：两个鸡蛋 → 鸡蛋', () => {
    const draft = parseHowToCook('dishes/soup/紫菜蛋花汤.md', fixture('howtocook-zicaidanhuatang.md'));
    const byName = new Map(draft!.ingredients.map((item) => [item.name, item]));
    expect(byName.has('鸡蛋')).toBe(true);
    // 「两个」不是克数（**不猜**）：留 null 等 LLM 重标，但原文份量要留作证据
    expect(byName.get('鸡蛋')?.adultGrams).toBeNull();
    expect(byName.get('鸡蛋')?.quantity).toContain('两个');
  });

  it('括号里的补充说明不进名字（AC 3）', () => {
    const draft = parseHowToCook('dishes/soup/紫菜蛋花汤.md', fixture('howtocook-zicaidanhuatang.md'));
    for (const item of draft!.ingredients) {
      expect(item.name).not.toContain('（');
      expect(item.name).not.toContain('可以多放些');
    }
  });

  it('整篇：紫菜蛋花汤的三条都进了（原先只剩「盐 2 克」）', () => {
    const draft = parseHowToCook('dishes/soup/紫菜蛋花汤.md', fixture('howtocook-zicaidanhuatang.md'));
    expect(draft!.ingredients.map((item) => item.name).sort()).toEqual(['干紫菜', '盐', '鸡蛋'].sort());
  });

  it('整篇：麻婆豆腐的十条都进了（原先丢 10 行，实测量化里最狠的一道）', () => {
    const draft = parseHowToCook('dishes/meat_dish/麻婆豆腐/麻婆豆腐.md', fixture('howtocook-mapodoufu.md'));
    const names = draft!.ingredients.map((item) => item.name);
    for (const expected of ['内脂豆腐', '咸鸭蛋', '五花肉', '大蒜', '生姜', '小米辣', '蒜蓉辣酱', '花椒', '食盐', '酱油']) {
      expect(names).toContain(expected);
    }
    // 克数原文里有明确重量的项要落值（`20-30g 五花肉` → 取上界）
    const byName = new Map(draft!.ingredients.map((item) => [item.name, item]));
    expect(byName.get('五花肉')?.adultGrams).toBe(30);
    expect(byName.get('酱油')?.adultGrams).toBe(10);
  });

  it('倒装不误伤正常行：`盐 2 克` / `虾 250g` / `主料：五花肉 300g` 照旧', () => {
    const draft = parseHowToCook('dishes/vegetable_dish/地三鲜/地三鲜.md', fixture('howtocook-disanxian.md'));
    const byName = new Map(draft!.ingredients.map((item) => [item.name, item]));
    expect(byName.get('茄子')?.adultGrams).toBe(200);
    expect(byName.get('土豆')?.adultGrams).toBe(150);
  });

  it('**描述句不当作倒装救回来**（宁可留着现状，也不把一句话当食材名）', () => {
    // `一般一个人可以食用 60ml-110ml 的米。` 这类是描述句，不是食材行。
    // 它原先的切法是「名字=前半句、份量=后半句」——本票**不改这条**（另一类洞，issue 划在范围外），
    // 但要钉住「倒装的修复没有把描述句也拉进来」。
    const draft = parseHowToCook('dishes/soup/米粥.md', fixture('howtocook-zicaidanhuatang.md').replace('10g 的干紫菜（喜欢紫菜的可以多放些）', '一般一个人可以食用 60ml-110ml 的米。'));
    // 没被倒装规则「救」成一个以句子开头的新名字
    for (const item of draft?.ingredients ?? []) {
      expect(item.name.startsWith('一般一个人可以食用')).toBe(false);
    }
  });
});

describe('HowToCook 采集（筛选口径：家常热度 + 忌口排除，不按菜系）', () => {
  it('从真实 markdown 里读出菜名、份量、食材与做法', () => {
    const draft = parseHowToCook('dishes/vegetable_dish/地三鲜/地三鲜.md', fixture('howtocook-disanxian.md'));
    expect(draft).toBeDefined();
    expect(draft!.name).toBe('地三鲜');
    expect(draft!.source).toBe('howtocook');
    expect(draft!.kind).toBe('veg');
    // 有克数的项直接落值，没有的留 null（等 LLM 重标）
    const byName = new Map(draft!.ingredients.map((item) => [item.name, item]));
    expect(byName.get('茄子')?.adultGrams).toBe(200);
    expect(byName.get('土豆')?.adultGrams).toBe(150);
    expect(byName.get('尖椒')?.adultGrams).toBeNull();
    // 原文份量文本留着——重标的输入与报告的证据
    expect(byName.get('尖椒')?.quantity).toContain('3');
    // 做法照抄原文（自由文本，只给掌勺者参考，不进推荐管线）
    expect(draft!.steps).toContain('土豆');
  });

  it('id 是稳定散列：同一篇菜反复采集得到同一个 id（重跑幂等，不会越导越多）', () => {
    const text = fixture('howtocook-disanxian.md');
    const first = parseHowToCook('dishes/vegetable_dish/地三鲜/地三鲜.md', text);
    const second = parseHowToCook('dishes/vegetable_dish/地三鲜/地三鲜.md', text);
    expect(first!.id).toBe(second!.id);
    expect(first!.id).toMatch(/^htc_[0-9a-f]{12}$/);
  });

  it('非家常目录（饮品/甜点/早餐/调料/半成品）不进外部池', () => {
    const text = fixture('howtocook-disanxian.md');
    expect(parseHowToCook('dishes/drink/柠檬水.md', text)).toBeUndefined();
    expect(parseHowToCook('dishes/dessert/双皮奶.md', text)).toBeUndefined();
    expect(parseHowToCook('dishes/breakfast/煎蛋.md', text)).toBeUndefined();
    expect(parseHowToCook('dishes/condiment/辣椒油.md', text)).toBeUndefined();
  });

  it('忌口粗筛：内脏 / 贝类 / 生食这类素材在导入期就排掉', () => {
    const text = fixture('howtocook-disanxian.md');
    expect(parseHowToCook('dishes/meat_dish/爆炒猪肝.md', text.replace('# 地三鲜的做法', '# 爆炒猪肝的做法'))).toBeUndefined();
    expect(parseHowToCook('dishes/aquatic/刺身拼盘.md', text.replace('# 地三鲜的做法', '# 刺身拼盘的做法'))).toBeUndefined();
  });

  it('缺「## 计算」段落就不采（没有可重标的份量，落库只会是一道空菜）', () => {
    expect(parseHowToCook('dishes/meat_dish/随便.md', '# 随便的做法\n\n## 操作\n\n1. 炒。')).toBeUndefined();
  });

  it('荤素位按目录与食材判：汤分荤素（忌口与结构位判定都要它）', () => {
    expect(kindFrom('soup', '冬瓜丸子汤', ['冬瓜', '猪肉末'])).toBe('soup_meat');
    expect(kindFrom('soup', '紫菜蛋花汤', ['紫菜', '鸡蛋'])).toBe('soup_veg');
    expect(kindFrom('vegetable_dish', '地三鲜', ['茄子'])).toBe('veg');
    expect(kindFrom('meat_dish', '红烧肉', ['五花肉'])).toBe('meat');
  });

  it('菜系只是参考 tag：能认出就给，认不出就留 null（绝不参与筛选）', () => {
    const mapo = parseHowToCook(
      'dishes/meat_dish/麻婆豆腐/麻婆豆腐.md',
      fixture('howtocook-disanxian.md').replace('# 地三鲜的做法', '# 麻婆豆腐的做法'),
    );
    expect(mapo?.cuisine).toBe('川');
    const plain = parseHowToCook(
      'dishes/meat_dish/随便炒个菜/随便炒个菜.md',
      fixture('howtocook-disanxian.md').replace('# 地三鲜的做法', '# 随便炒个菜的做法'),
    );
    expect(plain?.cuisine).toBeNull();
  });

  it('一篇真菜谱里带克数与不带克数的项都能读出来（白灼虾：只有主料有克数）', () => {
    const draft = parseHowToCook('dishes/aquatic/白灼虾/白灼虾.md', fixture('howtocook-baizhuoxia.md'));
    expect(draft).toBeDefined();
    const byName = new Map(draft!.ingredients.map((item) => [item.name, item]));
    expect(byName.get('虾')?.adultGrams).toBe(250);
    expect(byName.get('姜')?.adultGrams).toBeNull();
    expect(byName.get('姜')?.scaling).toBe('fixed');
  });
});

describe('下厨房采集（来源如实标「爬取」）', () => {
  it('热榜页解析出菜名与详情页 URL', () => {
    const entries = parseXiachufangHtml(fixture('xiachufang-explore.html'));
    // 夹具是缩减过的（只留六条；真页面 25 条，形状一致）——这里验的是解析口径不是条数
    expect(entries.length).toBe(6);
    for (const entry of entries) expect(entry.url).toMatch(/^https:\/\/www\.xiachufang\.com\/recipe\/\d+\/$/);
    // 名字清掉了 emoji 与装饰（实测卡片名带 ❗️🔥🥞 这些）
    expect(entries.every((entry) => !/[\u{1F300}-\u{1FAFF}]/u.test(entry.name))).toBe(true);
    expect(entries.map((entry) => entry.name)).toContain('蒜蓉蚝油生菜');
  });

  it('详情页的原料表读成「名字 + 原文份量」，模糊份量留 null 等重标', () => {
    const ingredients = parseXiachufangDetail(fixture('xiachufang-detail.html'));
    const byName = new Map(ingredients.map((item) => [item.name, item]));
    expect(byName.get('生菜')?.quantity).toBe('一个');
    expect(byName.get('生菜')?.adultGrams).toBeNull();
    expect(byName.get('蒜')?.quantity).toBe('5瓣');
    expect(byName.get('盐')?.quantity).toBe('适量');
    expect(byName.get('盐')?.scaling).toBe('fixed');
  });

  it('组装成草稿时来源标 scraped（许可风险隔离在素材层，ADR-0006）', () => {
    const draft = xiachufangDraft(
      { name: '蒜蓉蚝油生菜', url: 'https://www.xiachufang.com/recipe/107491076/' },
      fixture('xiachufang-detail.html'),
    );
    expect(draft).toBeDefined();
    expect(draft!.source).toBe('scraped');
    expect(draft!.sourceRef).toBe('https://www.xiachufang.com/recipe/107491076/');
    expect(draft!.steps).not.toBe('');
    // 生菜 → 蚝油带来隐性忌口（小宝忌贝类），这条关联靠归一后的食材清单推出来
    expect(draft!.ingredients.map((item) => item.name)).toContain('蚝油');
  });

  it('详情页没有原料表就不组装（页面结构变了 → 进报告的「跳过」，不落半截）', () => {
    expect(xiachufangDraft({ name: '空页', url: 'https://www.xiachufang.com/recipe/1/' }, '<html></html>')).toBeUndefined();
  });
});

describe('LLM 生成的草稿（与另两条来源走同一条管线）', () => {
  it('来源标 llm，缺克数的项照模糊份量处理（等重标，不编默认值）', () => {
    const draft = llmGeneratedDraft(
      {
        name: '番茄豆腐汤',
        ingredients: [
          { name: '番茄', adultGrams: 200 },
          { name: '豆腐', quantity: '一块' },
        ],
      },
      '2025-09-19T00:00:00.000Z',
    );
    expect(draft.source).toBe('llm');
    expect(draft.kind).toBe('soup_veg');
    expect(draft.ingredients[1]!.adultGrams).toBeNull();
    expect(draft.ingredients[1]!.quantity).toBe('一块');
    expect(draft.id).toMatch(/^llm_[0-9a-f]{12}$/);
  });
});

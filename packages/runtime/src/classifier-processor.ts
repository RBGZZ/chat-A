/**
 * ClassifierProcessor —— B 层帧管线「三层过滤分流」处理器(承 §4.2 + frame-processing spec)。
 *
 * 从 LLM 文本中**剥离**三类非口语内容并分流为三路下游:
 *   1. 工具调用片段(`<tool>…</tool>` / 行内 JSON 工具指令)→ 既不显示也不朗读(由工具通道另行处理);
 *   2. 表情标签(`[微笑]` / `(开心)` / `*叹气*` / emoji)→ 提取为 `emotionTags`(→ 人格/姿态),不朗读;
 *   3. 舞台指示(`（小声说）`/`【停顿】` 等动作/旁白)→ 从口语剥离,保留进 `displayText`(供记录/字幕),不朗读。
 *
 * 输出三路(承 spec):
 *   - `spokenText`:仅含可朗读口语(已剥所有标签)→ TTS;
 *   - `emotionTags`:提取到的情绪/动作标签(去重、保序)→ 人格;
 *   - `displayText`:供显示/记录的文本(剥工具调用,保留舞台指示与原口语)→ 记录。
 *
 * **纯函数**(承 spec「同输入同输出,可 golden test」):无内部状态、不读时钟、不触总线;
 * 标签/标点集合全为常量(无 magic number,行为即配置)。
 *
 * 注:这是「内容分类/过滤」纯函数,与 `SentenceAggregator`(句级聚合)正交;
 * 帧管线里二者可串联(先 aggregate 成句,再对每句 classify 分流),亦可独立使用。
 */

/** 三层过滤分流结果(承 §4.2:口语→TTS / 情绪→人格 / 显示→记录)。 */
export interface ClassifiedText {
  /** 可朗读口语(剥所有标签/工具/舞台指示)→ TTS。 */
  readonly spokenText: string;
  /** 供显示/记录的文本(剥工具调用,保留舞台指示)→ 记录。 */
  readonly displayText: string;
  /** 提取到的情绪/动作标签(去重、保序)→ 人格。 */
  readonly emotionTags: readonly string[];
}

/**
 * 工具调用片段:`<tool ...>...</tool>` 块,或行内 `<tool .../>` 自闭合。
 * 工具真正走模型侧 tool-use 通道,这里只做**防御性剥离**(模型若误把工具语义混入文本输出)。
 */
const TOOL_BLOCK_RE = /<tool\b[^>]*>[\s\S]*?<\/tool>|<tool\b[^>]*\/>/gi;

/**
 * 表情/动作标签:`[xx]`、`（xx）`/`(xx)`、`*xx*`、`【xx】`。
 * 全角/半角括号、星号包裹皆视作标签。捕获组 1..4 取标签文字(剥包裹符)。
 */
const TAG_RE = /\[([^\]]*)\]|（([^）]*)）|\(([^)]*)\)|\*([^*]*)\*|【([^】]*)】/g;

/**
 * Emoji(基本面 + 常见区段):作为情绪标签提取,不朗读。
 * 仅取常见情绪相关区段(表情符号、补充符号、杂项符号),避免误伤普通标点。
 */
const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;

/**
 * 舞台指示判定:标签文字若以这些动词/旁白线索开头(或整体为动作短语),视为「舞台指示」——
 * 从口语剥离但保留进 displayText(供字幕/记录),而非当作纯情绪标签丢弃。
 * 取**保守白名单**:常见动作/旁白词;命中则归舞台指示,否则归情绪标签。
 */
const STAGE_DIRECTION_HINTS = [
  '小声',
  '大声',
  '停顿',
  '沉默',
  '旁白',
  '画外音',
  '低声',
  '清嗓',
  '咳嗽',
  '转身',
  '看向',
  '走近',
];

/** 折叠多余空白(剥标签后常留空洞);保留单空格分隔,trim 两端。 */
function collapseSpaces(s: string): string {
  return s.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([，。！？、；：,.!?;:])/g, '$1').trim();
}

/** 判断一个标签文字是否为舞台指示(动作/旁白),否则视为情绪标签。 */
function isStageDirection(tag: string): boolean {
  const t = tag.trim();
  return STAGE_DIRECTION_HINTS.some((h) => t.startsWith(h));
}

/**
 * 三层过滤纯函数:输入 LLM 文本(可为整段或单句),产出 `{spokenText, displayText, emotionTags}`。
 *
 * 处理顺序(确定性):
 *   1. 剥工具调用块 → 得 `noTool`(displayText 基底:工具不显示不朗读)。
 *   2. 扫描 `noTool` 的所有标签:舞台指示保留进 displayText、从 spoken 剥;情绪标签提取进 tags、两路都剥。
 *   3. 提取 emoji 为情绪标签,从 spoken 与 display 剥(emoji 不朗读、记录里也无朗读价值)。
 *   4. spokenText/displayText 各自折叠空白、trim;emotionTags 去重保序。
 */
export function classifyText(input: string): ClassifiedText {
  // 1. 剥工具调用(既不显示也不朗读)。
  const noTool = input.replace(TOOL_BLOCK_RE, '');

  const emotionTags: string[] = [];
  const seen = new Set<string>();
  const addTag = (raw: string): void => {
    const tag = raw.trim();
    if (tag.length === 0 || seen.has(tag)) return;
    seen.add(tag);
    emotionTags.push(tag);
  };

  // 2. 扫描标签:区分舞台指示(保留进 display)与情绪标签(两路剥)。
  //    用单次正则遍历,据命中的捕获组取标签文字。
  let spoken = '';
  let lastIndex = 0;
  for (const m of noTool.matchAll(TAG_RE)) {
    const idx = m.index;
    spoken += noTool.slice(lastIndex, idx);
    lastIndex = idx + m[0].length;
    // 命中的捕获组(任一非 undefined)即标签文字。
    const tagText = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '';
    if (isStageDirection(tagText)) {
      // 舞台指示:不朗读(不进 spoken),但保留进 display(下方据 noTool 另算,故此处仅记入 tags 供追溯)。
      addTag(tagText);
    } else {
      // 情绪标签:提取,两路都不保留。
      addTag(tagText);
    }
  }
  spoken += noTool.slice(lastIndex);

  // displayText 基底:剥工具后的文本,保留舞台指示原样(只剥情绪标签会让字幕缺动作语境,
  // 故 display 仅剥工具 + emoji;舞台指示与口语都留)。但情绪标签([微笑] 等)对字幕意义不大,
  // 为简明与可测一致:display 剥情绪标签、保留舞台指示。
  let display = '';
  let dLast = 0;
  for (const m of noTool.matchAll(TAG_RE)) {
    const idx = m.index;
    const tagText = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '';
    if (isStageDirection(tagText)) {
      // 保留舞台指示原文(含包裹符)进 display。
      display += noTool.slice(dLast, idx + m[0].length);
    } else {
      // 情绪标签:从 display 剥(只保留其前的文本)。
      display += noTool.slice(dLast, idx);
    }
    dLast = idx + m[0].length;
  }
  display += noTool.slice(dLast);

  // 3. 提取 emoji 为情绪标签,从 spoken 与 display 剥。
  for (const e of spoken.matchAll(EMOJI_RE)) addTag(e[0]);
  spoken = spoken.replace(EMOJI_RE, '');
  display = display.replace(EMOJI_RE, '');

  return {
    spokenText: collapseSpaces(spoken),
    displayText: collapseSpaces(display),
    emotionTags,
  };
}

/**
 * ClassifierProcessor:对 classifyText 的轻量类封装(便于在帧管线里作为命名处理器持有/串联)。
 * 本身无状态——每次 `classify` 委派纯函数,语义与 `classifyText` 完全一致(同输入同输出)。
 */
export class ClassifierProcessor {
  classify(input: string): ClassifiedText {
    return classifyText(input);
  }
}

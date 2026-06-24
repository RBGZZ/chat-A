## 1. 🔴 qwen-tts-realtime 补发 language_type(必修)

- [x] 1.1 `tts.ts` 加具名常量映射表 `ISO_TO_QWEN_LANGUAGE`(`zh→Chinese, en→English, ja→Japanese, ko→Korean, de→German, it→Italian, pt→Portuguese, es→Spanish, fr→French, ru→Russian`)+ 合法 Qwen 名集合(含 `Auto`)
- [x] 1.2 `tts.ts` 导出 helper `toQwenLanguageType(language?: string): string | undefined`:未给/未知码 → undefined;ISO 码 → 映射名;已是合法 Qwen 名 → 原样返回(大小写不敏感地归一到官方写法)
- [x] 1.3 `qwen-tts-realtime.ts` 的 `synthesize` 在 `session.update.session` 里:`toQwenLanguageType(opts?.language)` 有值才加 `language_type` 字段,无值不加(逐字回归);复刻分支补 target_model 一致性注释
- [x] 1.4 `index.ts` 导出 `toQwenLanguageType`(若需被装配/测试外用)

## 2. 🟡 复刻管理加固(qwen-voice-clone.ts)

- [x] 2.1 加分页常量 `QWEN_VOICE_CLONE_LIST_PAGE_SIZE`(默认 100);`buildManageBody('list')` 带 `page_index:0` + `page_size`(query/delete 不带分页)
- [x] 2.2 `parseVoiceList` 元素取 `item.voice` 失败时回退 `item.voice_id`
- [x] 2.3 注释从「按 CosyVoice 同族推断/待校准」改为「已据官方核实(2026-06-24)」;注明 CosyVoice 是另一套契约(`list_voice`/`delete_voice`+`voice_id`,语种走注册期 `language_hints`)
- [x] 2.4 复刻创建分支补 target_model ↔ 合成 model 一致性注释

## 3. 🟡 target_model 一致性(注释/文档)

- [x] 3.1 `packages/desktop/src/main.ts` 复刻处补强调注释(targetModel 必须与合成 model 同串;无功能改动)
- [x] 3.2 `docs/chat-a-canonical-design.md` 记一笔:vc 路径 target_model 与合成 model 必须逐字同串;CosyVoice 复刻语种机制相反(注册期 language_hints / 合成期无语种参数 / 语种焊音色),Factory 接 CosyVoice 别套用 qwen language_type 思路

## 4. 测试(mock,不触网)

- [x] 4.1 `tts.test.ts`:`toQwenLanguageType('zh')==='Chinese'`、`'en'==='English'`、未给 → undefined、未知码(如 `'xx'`)→ undefined、直传合法名(`'Chinese'`)→ 原样
- [x] 4.2 `qwen-tts-realtime.test.ts`:`synthesize(text,{language:'zh'})` → session.update.session.language_type==='Chinese';`'en'`→`'English'`
- [x] 4.3 `qwen-tts-realtime.test.ts` 回归:不给 language → session.update **不含** language_type;未知码 → 不含
- [x] 4.4 `qwen-voice-clone.test.ts`:list 请求体含 `page_index:0` + `page_size`
- [x] 4.5 `qwen-voice-clone.test.ts`:`parseVoiceList` 兼容 `{voice}` 与 `{voice_id}` 元素

## 5. 验证

- [x] 5.1 worktree 根 `pnpm -r typecheck` 全绿(`ELECTRON_SKIP_BINARY_DOWNLOAD=1` 跑 install)
- [x] 5.2 worktree 根 `npx vitest run` 全绿:新测试通过 + **未配置语种 / 不复刻回归绿**
- [x] 5.3 自检与 canonical 一致:§4.1/§4.3 能力门+语种解绑、§3.2 行为即配置;确认硬约束(不配置语种逐字不变)成立

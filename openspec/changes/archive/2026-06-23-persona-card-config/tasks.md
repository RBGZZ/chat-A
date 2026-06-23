## 1. 依赖与类型

- [x] 1.1 给 `@chat-a/persona` 加 `yaml` 依赖(纯 JS、零传递依赖),`pnpm install` 通过
- [x] 1.2 在 `persona/types.ts` 新增 `PersonaCard` 类型(name/identity/ocean/dials/greetings/lore[]/userProfile[],全可选)与加载结果 `LoadedPersonaCard = { seed: PersonaSeed; lore: string[]; userProfile: string[] }`

## 2. 加载器(纯函数 + 容错)

- [x] 2.1 新增 `persona/src/card-loader.ts`:`parsePersonaCard(rawYaml: string): LoadedPersonaCard`——YAML 解析 + 字段映射到默认种子;非法/缺省字段回落默认(复用 `num01` 夹取 OCEAN/旋钮),不抛
- [x] 2.2 `loadPersonaCard(path?: string): LoadedPersonaCard`:读文件→`parsePersonaCard`;文件缺失/读失败/YAML 失败→返回默认种子+空 lore/profile,并 `stderr` 告警(不崩,§3.2)
- [x] 2.3 改造 `config-loader.ts:loadPersonaSeedFromEnv`:先 `loadPersonaCard(env.CHAT_A_PERSONA_CARD)` 取基种子,再让现有 env 覆盖逻辑作用其上(默认<卡<env);导出能拿到 lore/userProfile 的装配函数(如 `loadPersonaFromEnv(): LoadedPersonaCard`)
- [x] 2.4 `persona/index.ts` 导出新类型与加载器

## 3. 编排接线(client)

- [x] 3.1 `client/cli.ts`:用 `loadPersonaFromEnv()` 取 `{seed, lore, userProfile}`;`CHAT_A_USER_PROFILE` 单行并入 `userProfile` 列表(兼容)
- [x] 3.2 启动时遍历 `lore` 调 `mem.store.addMemory({ text, kind:'self_lore', subject:'agent' })`;遍历 `userProfile` 调 `addMemory({ text, kind:'user_profile' })`(默认 subject=person/主用户),均幂等
- [x] 3.3 启动横幅打印生效来源:卡路径(或"默认种子")+ 是否有 env 覆盖 + lore/画像条数(§8.1 可追溯)

## 4. 测试(契约 + golden)

- [x] 4.1 `card-loader` golden test:完整卡→种子各字段正确(含 OCEAN 五维)、lore/userProfile 解析正确
- [x] 4.2 容错 test:文件缺失/非法 YAML→默认种子+空列表+不抛;单字段越界→只回落该字段、其余生效
- [x] 4.3 优先级 test:无卡无 env=默认;有 env 无卡=env 覆盖默认(等价旧行为);有卡+env=env 覆盖卡字段、其余取卡
- [x] 4.4 幂等 test(可用内存 store):同卡重复 seed lore/画像不新建重复条目(命中去重),agent/person 主语正确

## 5. 文档与收尾

- [x] 5.1 新增示例卡 `persona.example.yaml`(仓库根),含注释说明各字段
- [x] 5.2 更新 `start.bat`/README:PersonaCard 用法、`CHAT_A_PERSONA_CARD`、env 覆盖优先级、`CHAT_A_USER_PROFILE` 标注兼容
- [x] 5.3 全量 `pnpm typecheck` + `pnpm test` 通过;手动冒烟:带卡启动→横幅正确→对话能召回 lore/画像

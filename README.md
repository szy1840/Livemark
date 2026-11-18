# Livemark

> **本项目仅供学习和研究使用。** 这是一个个人练手项目，用来学习即时渲染 Markdown 编辑器的设计思路；代码全部从零编写，与 Typora 及其开发者没有任何关系。
>
> **For learning and research only.** A personal study project on how live-preview Markdown editors work. All code is written from scratch; not affiliated with Typora or its developers.

A live-preview Markdown editor for macOS and the browser, written from scratch: what you type renders in place, and the Markdown syntax shows only around the caret. Native Swift shell, plain-JavaScript editor, no bundler, no network.

一个从零写的、Typora 风格的即时渲染 Markdown 编辑器。同一套代码既能在浏览器里跑，也能打包成原生 Mac 应用。

## 运行

浏览器里：

```bash
npm start
```

然后打开 http://localhost:4173 。

Mac 应用：

```bash
./native/build.sh
```

生成 `dist/Livemark.app`，双击打开，也可以拖进“应用程序”。

其他命令：

- `npm test`：解析器检查
- `./native/build.sh --test`：构建并跑外壳自检（桥接、文件、菜单、导出）
- `dist/Livemark.app/Contents/MacOS/Livemark --script 脚本.js [文档.md]`：在隐藏窗口里启动应用，把脚本当作异步函数体在页面里执行，打印返回值后退出。页面上的 `window.livemark` 提供编辑器和各模块的入口，用来做不需要人盯屏幕的端到端检查
- `node scripts/vendor.mjs`：升级依赖后重新生成 `vendor/`

## 功能

**Markdown**

- 标题、段落、软换行、分隔线
- 引用（可嵌套）、GitHub 风格提示块（Note / Tip / Important / Warning / Caution）
- 无序、有序、任务列表，可嵌套，列表项里可以放段落和代码块
- 代码块（193 种语言高亮、可选行号）、公式块（KaTeX）、表格
- 图表：mermaid，并兼容旧式的 `sequence`、`flow` 写法
- 目录 `[toc]`、YAML Front Matter、脚注、链接引用定义、HTML 块（脚本会被去掉，iframe 进沙箱）
- 行内：粗体、斜体、行内代码、删除线、高亮、下划线、上下标、行内公式、表情短代码、链接、引用式链接、自动链接、图片、脚注引用、行内 HTML、注释、转义
- 方言选项：严格模式、标题写法（`#` 或下划线式）、列表符号、自动链接、提示块、```` ```math ```` 代码块公式、公式自动编号（全部或 AMS 规则）、physics 宏、解析时转换全角标点

**编辑**

- 即时渲染：光标进入时显示语法符号，离开时收起
- 段首输入 `# `、`- `、`1. `、`> `、`[ ] `、三个反引号、`$$`、`[toc]`、`---`、`|a|b|` 自动成块
- 括号和引号自动配对，可选的 Markdown 符号配对；智能引号和破折号可以选输入时转换或只在显示时转换
- 表情自动补全；大小写转换；代码块缩进宽度可设，Shift+Tab 减少缩进或自动缩进
- 脚注和链接定义可以放在文档末尾、章节末尾或当前块之后；可选引用式链接
- 撤销重做、跨段落选择编辑、多段粘贴、网页和 Word 内容粘贴成 Markdown
- 复制为 Markdown / HTML 代码 / 纯文本，复制到其他应用时带格式
- 表格工具：增删行列、移动行列、对齐、调整大小
- 图片：粘贴、拖入、一次插入多张、用 iPhone 拍照、缩放、切换 `<img>` 写法、批量归集到文件夹；光标所在图片的文件可以复制、重命名、移动、删除
- 图片插入规则：原地引用、复制到 `./assets` 等文件夹或上传（PicGo、PicList、uPic 或自定义命令）；可按文档在 Front Matter 里用 `typora-copy-images-to`、`typora-root-url` 单独设置
- 选中当前词 / 行 / 格式范围 / 块，对应的删除操作，文首文末跳转
- 查找和替换：区分大小写、全词、正则，源代码模式下同样可用
- 源代码模式、专注模式、打字机模式、只读模式

**文件**

- 打开、保存、全部保存、另存为、创建副本、重命名、移动、从磁盘重新载入、复原到上次保存、重新打开关闭的文件
- TextBundle（`.textbundle`）：文档和图片放在同一个包里
- 自动保存，未保存内容的草稿恢复，历史版本浏览与恢复
- 文件被其他程序改动时自动重新载入或询问
- 侧边栏：大纲（可折叠）、文件树、文件列表（带预览）、在文件夹中搜索；八种排序、按文件夹分组、按文件名筛选、隐藏文件、自定义显示规则、固定文件夹、Quick Look
- 快速打开、最近打开的文件和文件夹
- 导出 PDF（纸张、四边边距、页眉页脚、书签、一级标题前分页）、HTML（带或不带样式，可追加 head / body 内容）、图片（PNG 或 JPEG），以及通过 pandoc 导出 Word、OpenOffice、RTF、Epub、LaTeX、MediaWiki、reStructuredText、Textile、OPML
- 通过 pandoc 导入 docx、html、tex、rst、odt、epub 等
- 自定义导出格式（任意命令）、导出后运行命令、导出设置可由 Front Matter 覆盖
- 打印

**界面**

- 布局对照 Typora 的 Mac 版：系统原生标题栏和菜单栏；侧栏顶部是居中的视图名称，切换按钮在指针移入时出现；文件树带图标，文件列表是卡片；查找栏横贯窗口顶部；设置是带搜索框和七个分类的面板
- 菜单按 File、Edit、Paragraph、Format、View、Themes、Window、Help 排列，项目顺序与 Typora 一致
- 界面语言可在 Settings → General 里切换英文或简体中文
- 原生标签页（New Tab、Show Tab Bar）、系统分享、页面设置、Touch Bar、Unibody 窗口风格、可选的编辑工具栏
- 快捷键与 Typora 的 Mac 版一致，并可在高级设置文件 `conf.user.json` 里改
- 以其他编码重新打开、图片上传（自定义命令）、复制图片内容、表格源码对齐

**外观**

- 六套主题：Github、Gothic、Newsprint、Night、Pixyll、Whitey，字号、行距、颜色、表格和引用样式按 Typora 同名主题的数值设定，字体用开源的 Open Sans、PT Serif、Merriweather、Lato、Vollkorn（Gothic 用系统自带的几何无衬线字体）；可为深色模式单独指定主题
- 自定义主题：`~/Library/Application Support/Livemark/themes/` 里的 CSS 文件；设置里还有一栏自定义 CSS
- 字号、正文宽度、缩放、首行缩进、状态栏、字数统计

浏览器版受浏览器权限限制：打开文件夹需要 Chrome 或 Edge，没有窗口置顶，导出图片、pandoc 导入导出和自定义主题只在 Mac 应用里有。

## 为什么跟手

- 外壳是原生的 Swift 程序（`native/`），编辑器是内嵌的网页，两边通过 `src/platform.js` 通信。
- 正文是一个 contenteditable，打字由浏览器原生完成，只重绘被改动的那一段；结果和现有 DOM 一致时不写 DOM。
- Markdown 符号从不删除，只是藏起来（`.mk`）；光标进入时给它所在的标记加上 `data-open` 显示出来（`styles/editor.css`）。
- 光标用段内字符偏移量记录（`toPos` / `toDom`），重绘后照原样放回。
- 回车、粘贴在 `beforeinput` 里拦截，改模型后按段落 id 对比更新。
- 段落对象不可变，撤销快照就是数组引用。
- 正文没有动画，过渡只用在侧栏、查找栏、菜单和通知上。

代码全部是从零写的，没有使用 Typora 的源码、样式文件、图标或名称，也不包含授权、自动更新和统计相关的功能。

## 保存不改动没碰过的内容

打开一份文档、改其中一处再保存，其余部分逐字节不变。

- 解析时记下每个块来自原文的哪几行；块对象不可变，所以被编辑过的块自然不在这张表里。
- 写回时，没动过的块和它们之间的空行原样输出；只有编辑过或新建的块才重新生成。
- 重新生成的块也沿用原来的写法：列表符号（`*`、`+`、`1)`）、符号后的间距、缩进、字面编号、松散列表的空行、下划线式标题和它的下划线、标题结尾的 `#`、`~~~` 代码块、行尾两个空格的硬换行、紧凑写法的表格。

检查：

```bash
node test/roundtrip.mjs "$PWD"
```

```bash
node test/edited-blocks.mjs "$PWD"
```

## 行为对照

编辑行为按 Typora 的 Mac 版逐项对照过：对两边做同样的按键和粘贴，比较得到的 Markdown、光标位置和菜单。覆盖了行内语法的光标展开、列表/引用/标题里的回车退格和 Tab、表格、代码块边界、粘贴的合并方式、括号引号配对、输入触发的块、跨块选区、查找替换、字数统计、HTML 导出结构、撤销、复制到剪贴板的纯文本、大纲、文件面板、PDF 和图片导出。

几条不那么显然的规则：

- 撤销：同一段里连续输入（或连续删除）从第一下起 3 秒内算一步，换段、换方向、覆盖选区、执行命令都会另起一步；撤销后光标回到这一步之前的位置。`# ` 变标题属于输入这一步，`- `、`> ` 变列表和引用是单独一步，撤销先退回字面的标记。
- 复制：纯文本默认是 Markdown 源码；关掉这个选项后是读者看到的文字，列表保留标记并重新编号，代码缩进 4 格，表格按列对齐后用制表符分隔。只选了一个行内格式里的一部分时，不带出半边标记。
- 大纲：默认只展开到顶层（只有一个顶层标题时展开它），点箭头展开一层，点标题跳过去并展开它，光标不动；加粗的是当前可见的第一个标题，它被折叠时加粗它的上级。
- 文件面板：没有打开文件夹时，显示当前文档所在的文件夹。

这一轮补齐的小功能：保存时的缩进宽度（2 / 4，可选整齐缩进）、旧版行内公式解析（兼容模式）、复制和导出的 HTML 里公式用 LaTeX 源码、代码和链接里的拼写检查、文件树和文章列表各自的排序、智能引号跟随系统键盘设置里的引号字符、TextPack（.textpack，打开时解包、保存时重新打包）；右键菜单里的格式化代码（prettier，JS / TS / JSON / CSS / HTML / Markdown / YAML / GraphQL）、学习/取消学习拼写、媒体另存为、复制表情、编辑原始块、复制为图片、复制到 MS Word、不带主题样式复制。

Typora 有而这里没有的：单色表情（Typora 只在 Windows 上生效）；授权、自动更新、统计不做。

- 保存时的缩进宽度：自动 / 2 / 3 / 4 / 5 / Tab 六档，和 Typora 相同；Tab 档每层写一个制表符。
- PDF：默认页边距左右 36pt、上下 45pt，页面按打印页的惯例缩到 80%（16px 的正文印出来是 12.8pt），列表在纸上缩进 40px。
- 图片：整篇文档一张图，默认 640px 宽，1 个 CSS 像素对应 1 个图片像素，四周留 30px。

## 结构

- `src/inline.js`：行内 Markdown 转 HTML，保证 `textContent` 等于源文本
- `src/markdown.js`：Markdown 文本和段落数组互转。文档是一个扁平数组，嵌套靠每个段落上的引用层数和列表层数表示
- `src/rich.js`：代码高亮、公式、图表、HTML 块的安全渲染
- `src/editor.js`、`src/editor-ops.js`：编辑器核心和全部编辑命令
- `src/convert.js`：导出 HTML、粘贴的 HTML 转 Markdown
- `src/menus.js`：一棵命令树同时驱动原生菜单、页面菜单栏、快捷键和右键菜单
- `src/platform.js`：浏览器和 Mac 应用两种宿主的统一接口
- `src/app.js`、`src/sidebar.js`、`src/find.js`、`src/prefs.js`、`src/ui.js`、`src/toolbar.js`、`src/complete.js`：应用外壳
- `native/`：Mac 应用的 Swift 源码和构建脚本
- `vendor/`：KaTeX、Mermaid、highlight.js、表情表

## 许可

0BSD（BSD Zero Clause License），见 [LICENSE](LICENSE)：可以随意使用、复制、修改和分发，不需要保留署名。`vendor/` 里的第三方库和字体各自沿用原许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

Livemark 是独立项目，和 Typora 及其开发者没有任何关系；文中提到 Typora 只是为了说明行为对照的对象。

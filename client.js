/**
 * Client half of `dsh-token-frugal`: the graded saving-mode panel under the
 * composer, and the token-saving page inside Settings.
 *
 * The browser artifact is a lazy factory whose id equals the package name, so
 * the page's module table hands it React and nothing else. It mounts into
 * `conversation.composer.dock` ("ambient entries below the composer card") and
 * into `settings.section` ("one settings page per list entry"), and talks to
 * the Host half over the exact HTTP routes the Host half registers — the bridge
 * a profile-installed bundle can actually use.
 *
 * The panel groups its nine switches into three grades — 初等 / 中等 / 高等 —
 * and renders them as an accordion: opening one grade closes the others, so the
 * card never grows past the height of a single grade. The settings page reads
 * the host's running saving record and can clear its cumulative half.
 *
 * Visible text is pinned to Chinese by `PANEL_LOCALE`: the Client `locale`
 * service is not reliably readable from a profile-installed bundle, so
 * following it meant silently falling back to English. Every colour comes from
 * a `--dsw-alias-*` theme token, so light and dark both read correctly without
 * a second stylesheet.
 *
 * This file holds Chinese literals. Edit it with a Unicode-safe tool and keep
 * it UTF-8 without a BOM; a lossy round trip through a shell replaces every
 * character with U+FFFD, which the load check now refuses.
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-frugal',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** The Host half's routes; kept in one place so both halves agree. */
    const ENDPOINT = '/dsh-token-frugal/modes';
    const STATS_ENDPOINT = '/dsh-token-frugal/stats';

    /**
     * Panel copy, keyed by locale.
     *
     * The Chinese lines are the shipped ones and are written for the person
     * deciding whether to keep a saving on: every mode names the exact thing it
     * removes or folds, and says whether the change is reversible. They avoid
     * metaphors ("藏起工具") in favour of the term the model actually sees
     * ("工具目录精简"), because a switch's label is the only documentation the
     * user reads before flipping it.
     */
    const TEXT = {
      en: {
        title: 'Token savings',
        collapsed: (on, total) => `Token savings · ${on}/${total} on`,
        hint: 'Applies at once, no restart.',
        openAll: 'Turn all on',
        closeAll: 'Turn all off',
        unavailable: 'off',
        savedTo: 'settings in',
        notSaved: 'not saved (no config folder found)',
        failed: 'Could not reach the plugin',
        depthTitle: 'Elision depth',
        depthHint: 'cut measured at source',
        depthNote: (value) => `−${value}% prompt`,
        depths: { standard: 'Standard', deep: 'Deep', extreme: 'Extreme' },
        statsHint: 'Full saving report: Settings → Token savings',
        tiers: {
          basic: ['Basic', 'Removes whitespace and control codes only; no semantic content changes'],
          medium: ['Intermediate', 'Folds repeated lines and rising counters into ranges; the content is reconstructable'],
          advanced: ['Advanced', 'Truncates long results and rewrites what the model sees; there is a real trade-off'],
        },
        modes: {
          terminal: ['Terminal control codes', 'Strips ANSI colour and cursor sequences from command output'],
          columns: ['Alignment padding', 'Collapses runs of spaces that exist only to line columns up'],
          json: ['JSON layout', 'Expands compact JSON and lays regular arrays out as tables'],
          repeatedLines: ['Repeated lines', 'Merges consecutive identical lines into one line plus a count'],
          numericRuns: ['Rising counters', 'Folds a consecutive counter into a start-end range'],
          elide: ['Long-result trimming', 'Keeps head and tail and names a locator for the omitted middle'],
          catalogue: ['Tool-catalogue trimming', 'Removes the configured tools from the schemas the model receives'],
          memo: ['Session memory', 'Appends your input and each turn summary to the workspace memory file'],
          recall: ['Memory recall', 'Injects matching excerpts when a new message hits the memory file'],
        },
        stats: {
          nav: 'Token savings',
          title: 'Token savings report',
          subtitle: 'Priced with the same 4-characters-per-token heuristic the Harness uses for context usage.',
          hero: 'Estimated tokens saved',
          heroSub: (chars) => `from ${chars} characters removed (compression only)`,
          session: 'This process',
          cumulative: 'All time',
          calls: 'Tool results inspected',
          rewritten: 'Results rewritten',
          elided: 'Results trimmed',
    aged: 'Aged digests',
          saved: 'Characters removed',
          tokens: 'Tokens saved',
          ratio: 'Saved share',
          spillFailures: 'Spill failures',
          recall: 'Recall injections',
          recallChars: 'Recall characters',
          catalogue: 'Catalogue saving',
          catalogueDetail: (tools, tokens) => `${tools} tool(s) hidden · about ${tokens} tokens per request`,
          byTool: 'By tool',
          tool: 'Tool',
          empty: 'Nothing compressed yet. The numbers appear after the first tool call is rewritten.',
          note: 'The catalogue figure is per request, not a total: hidden schemas are missing from every request the agent makes.',
          file: 'Statistics file',
          none: 'not persisted (no config folder found)',
          generated: 'Updated',
          refresh: 'Refresh',
          reset: 'Clear all-time record',
          confirm: 'Clear the all-time record?',
          confirmYes: 'Clear',
          confirmNo: 'Cancel',
          failed: 'Could not reach the plugin',
        },
      },
      zh: {
        title: '省 Token 设置',
        collapsed: (on, total) => `省 Token · 已开 ${on}/${total}`,
        hint: '改动立即生效，无需重启。',
        openAll: '全部开启',
        closeAll: '全部关闭',
        unavailable: '未启用',
        savedTo: '设置文件',
        notSaved: '未写入磁盘（未找到配置目录）',
        failed: '无法连接插件',
        depthTitle: '截断深度',
        depthHint: '源头截断强度',
        depthNote: (value) => `提示词 −${value}%`,
        depths: { standard: '标准', deep: '深度', extreme: '极限' },
        statsHint: '完整节省统计：设置 → 省 Token 统计',
        tiers: {
          basic: ['初等', '只清理空白与控制符，不改变任何语义内容'],
          medium: ['中等', '把重复行与递增计数折叠成区间，内容可无损还原'],
          advanced: ['高等', '截断超长结果并改写模型可见内容，存在信息取舍'],
        },
        modes: {
          terminal: ['终端控制符', '删除命令行输出中的 ANSI 颜色与光标控制序列'],
          columns: ['对齐空白', '压缩仅为对齐列而输入的连续空格'],
          json: ['JSON 规整', '展开紧凑 JSON，并把规整数组排列成表格'],
          repeatedLines: ['重复行折叠', '把连续重复的同一行合并为一行并标注出现次数'],
          numericRuns: ['递增计数折叠', '把连续递增的计数折叠为「起始-结束」区间'],
          elide: ['超长结果截断', '只保留首尾，并为省略的中段给出可读回的定位提示'],
          catalogue: ['工具目录精简', '从模型收到的工具定义中移除已配置的工具'],
          memo: ['会话记忆', '把用户输入与每轮要点追加写入工作区记忆文件'],
          recall: ['记忆召回', '新消息命中记忆文件时，把匹配片段注入本次请求'],
        },
        stats: {
          nav: '省 Token 统计',
          title: '省 Token 统计',
          subtitle: '按 Harness 显示上下文用量时的同一套估算口径（4 字符 ≈ 1 token）折算。',
          hero: '累计节省 Token（估算）',
          heroSub: (chars) => `来自被移除的 ${chars} 个字符（仅统计压缩）`,
          session: '本次进程',
          cumulative: '历史累计',
          calls: '检查过的工具结果',
          rewritten: '被重写的结果',
          elided: '被截断的结果',
    aged: '时效替换',
          saved: '移除的字符数',
          tokens: '节省的 Token',
          ratio: '节省比例',
          spillFailures: '原文留存失败',
          recall: '记忆注入次数',
          recallChars: '记忆注入字符数',
          catalogue: '工具目录精简',
          catalogueDetail: (tools, tokens) => `隐藏 ${tools} 个工具 · 每次请求约省 ${tokens} token`,
          byTool: '按工具明细（本次进程）',
          tool: '工具',
          empty: '暂无压缩记录：第一个被重写的工具结果出现后，这里就会有数据。',
          note: '工具目录数字是「每次请求」的量，不是累计值：只要受限生效，模型收到的每一份请求都少这几个工具的 schema。',
          file: '统计文件',
          none: '未写入磁盘（未找到配置目录）',
          generated: '更新时间',
          refresh: '刷新',
          reset: '清除历史累计',
          confirm: '确认清除历史累计记录？',
          confirmYes: '确认清除',
          confirmNo: '取消',
          failed: '无法连接插件',
        },
      },
    };

    /**
     * Panel language. Pinned to Chinese on purpose: this panel's audience is the
     * profile's user, and the Client `locale` service could not be read reliably
     * from a profile-installed bundle, so following it meant silently falling
     * back to English. Set this to 'en' to switch the whole surface back.
     */
    const PANEL_LOCALE = 'zh';

    /**
     * The three grades, in the order a cautious user should read them.
     *
     * Assignment is by what a wrong choice costs: `basic` is lossless by
     * construction, `medium` folds structure that is encoded in the text
     * itself, `advanced` either drops content or changes what the model is
     * shown. Every mode id in `MODE_IDS` must appear exactly once — the panel
     * renders the grades, not the raw mode list, so an unassigned mode would
     * simply disappear from the UI.
     */
    const TIERS = [
      { id: 'basic', modes: ['terminal', 'columns', 'json'] },
      { id: 'medium', modes: ['repeatedLines', 'numericRuns'] },
      { id: 'advanced', modes: ['elide', 'catalogue', 'memo', 'recall'] },
    ];

    /** A finite, non-negative number from any wire value. */
    const number = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

    /** A token count at a glance: 1234 -> 1,234, 23456 -> 23.5k. */
    const compact = (value) => {
      const n = Math.round(number(value));
      if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
      if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
      return n.toLocaleString('en-US');
    };

    /** A [0, 1] ratio as a percentage. */
    const percent = (value) => `${(Math.min(1, number(value)) * 100).toFixed(1)}%`;

    /** A short local timestamp for the "updated" line. */
    const stamp = (value) => {
      if (typeof value !== 'string' || value === '') return '—';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    };

    /** The horizontal switch used by every mode row. */
    function Switch(props) {
      const { on, disabled, label, mode, onToggle } = props;
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': label,
        // The stable mode id, for anything that needs to address a switch
        // without depending on its localized label.
        'data-mode': mode,
        disabled,
        onClick: onToggle,
        style: {
          flex: '0 0 auto', width: '32px', height: '18px',
          borderRadius: '9px', border: '1px solid var(--dsw-alias-border-l2)',
          background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
          cursor: disabled ? 'default' : 'pointer',
          position: 'relative', padding: 0, transition: 'background 120ms ease',
        },
      }, h('span', {
        style: {
          position: 'absolute', top: '1px', left: on ? '15px' : '1px',
          width: '14px', height: '14px', borderRadius: '50%',
          background: 'var(--dsw-alias-bg-base)', transition: 'left 120ms ease',
        },
      }));
    }

    /** One mode, as a full-width row: name and consequence on the left. */
    function ModeRow(props) {
      const { id, on, available, text, busy, onToggle } = props;
      const [label, description] = text.modes[id] ?? [id, ''];
      const disabled = available === false || busy === id;
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '7px 9px', borderRadius: '8px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
          opacity: available === false ? 0.55 : 1,
        },
      },
      h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
        h('div', {
          style: { fontSize: '12px', lineHeight: '16px', color: 'var(--dsw-alias-label-primary)' },
        }, label, available === false ? h('span', {
          style: { marginLeft: '4px', fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' },
        }, `（${text.unavailable}）`) : null),
        h('div', {
          style: {
            marginTop: '2px', fontSize: '11px', lineHeight: '15px',
            color: 'var(--dsw-alias-label-secondary)',
          },
        }, description),
      ),
      h(Switch, { on, disabled, label, mode: id, onToggle: () => onToggle(id, !on) }),
      );
    }

    /** One grade: a header row that opens its modes, closed by default. */
/**
 * The Advanced grade’s elision depth: one budget table per tier.
 *
 * These three are a radio group rather than three switches, because a
 * profile sits on exactly one tier and the host refuses a depth it does not
 * know. The percentage is the measured prompt reduction over this workspace’s
 * recorded sessions — an estimate of the tier, not a promise for a session.
 */
function DepthPicker(props) {
 const { current, options, onPick, busy, text } = props;
 const list = Array.isArray(options) ? options : [];
 if (list.length === 0) return null;
 return h('div', {
 style: {
 display: 'flex', flexDirection: 'column', gap: '5px',
 marginTop: '2px', padding: '7px 9px', borderRadius: '8px',
 border: '1px solid var(--dsw-alias-border-l1)',
 background: 'var(--dsw-alias-bg-layer-1)',
 },
 },
 h('div', {
 style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' },
 },
 h('span', { style: { fontSize: '11px', fontWeight: 600 } }, text.depthTitle),
 h('span', {
 style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' },
 }, text.depthHint),
 ),
 h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
 list.map((depth) => {
 const on = depth.id === current;
 const [label] = text.depths[depth.id] ?? [depth.id];
 return h('button', {
 key: depth.id,
 type: 'button',
 role: 'radio',
 'aria-checked': on ? 'true' : 'false',
 'data-depth': depth.id,
 disabled: busy || on,
 onClick: () => onPick(depth.id),
 title: text.depthNote(depth.promptReductionPercent),
 style: {
 display: 'inline-flex', alignItems: 'center', gap: '5px',
 padding: '3px 9px', borderRadius: '999px',
 border: '1px solid ' + (on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'),
 background: on ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
 color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
 fontSize: '11px', lineHeight: '16px', font: 'inherit',
 cursor: disabled ? 'default' : 'pointer',
 },
 }, h('span', null, label),
 h('span', { style: { fontSize: '10px', opacity: 0.75 } }, text.depthNote(depth.promptReductionPercent)),
 );
 }),
 ),
 );
}

    function TierBlock(props) {
      const { tier, open, onToggle, onSetAll, modes, text, busy, onToggleMode, depth } = props;
      const [label, note] = text.tiers[tier.id] ?? [tier.id, ''];
      const rows = tier.modes.map((id) => modes.find((mode) => mode.id === id)).filter(Boolean);
      const usable = rows.filter((mode) => mode.available !== false);
      const onCount = usable.filter((mode) => mode.on).length;
      const allOn = usable.length > 0 && onCount === usable.length;
      return h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
          overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-2)',
        },
      },
      h('button', {
        type: 'button',
        onClick: () => onToggle(tier.id),
        'aria-expanded': open ? 'true' : 'false',
        style: {
          display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
          padding: '8px 10px', border: 0, background: 'transparent',
          color: 'inherit', font: 'inherit', textAlign: 'left',
          cursor: 'pointer', boxSizing: 'border-box',
        },
      },
      h('span', { style: { flex: '0 0 auto', fontSize: '12px', fontWeight: 600 } }, label),
      h('span', {
        style: {
          flex: '1 1 auto', minWidth: 0, fontSize: '11px', lineHeight: '15px',
          color: 'var(--dsw-alias-label-secondary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
      }, note),
      h('span', {
        style: {
          flex: '0 0 auto', fontSize: '11px',
          color: onCount > 0 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
        },
      }, `${onCount}/${rows.length}`),
      h('span', {
        style: { flex: '0 0 auto', fontSize: '9px', color: 'var(--dsw-alias-label-secondary)' },
      }, open ? '▾' : '▸'),
      ),
      open ? h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '0 10px 10px' },
      },
      h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
        h('button', {
          type: 'button',
          disabled: usable.length === 0 || busy === tier.id,
          onClick: () => onSetAll(tier, !allOn),
          style: {
            padding: '2px 8px', borderRadius: '999px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: '10px', lineHeight: '16px', font: 'inherit',
            cursor: usable.length === 0 ? 'default' : 'pointer',
          },
        }, allOn ? text.closeAll : text.openAll),
      ),
      rows.map((mode) => h(ModeRow, {
        key: mode.id, id: mode.id, on: mode.on, available: mode.available,
        text, busy, onToggle: onToggleMode,
})),
            depth ? h(DepthPicker, depth) : null,
      ) : null,
      );
    }

    /**
     * The dock entry: a collapsed count that expands into the three grades.
     * @returns the panel element.
     */
    function TokenFrugalPanel() {
      const [state, setState] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [tier, setTier] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');

      const text = TEXT[PANEL_LOCALE] ?? TEXT.en;

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setState(await response.json());
          setError('');
        } catch (failure) {
          setError(`${text.failed}: ${String(failure?.message ?? failure)}`);
        }
      }, [text]);

      React.useEffect(() => { load(); }, [load]);

      /**
       * Send one mode patch and adopt the host's answer. The panel answers
       * immediately and reverts every optimistic cell on failure.
       */
      const commit = async (patch, depth) => {
        const previous = state;
        setState((current) => current === null ? current : {
          ...current,
          modes: current.modes.map((mode) => (Object.hasOwn(patch, mode.id) ? { ...mode, on: patch[mode.id] } : mode)),
          elisionDepth: depth === undefined ? current.elisionDepth : depth,
        });
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(depth === undefined ? { modes: patch } : { modes: patch, depth }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setState(await response.json());
          setError('');
        } catch (failure) {
          setState(previous);
          setError(`${text.failed}: ${String(failure?.message ?? failure)}`);
        }
      };

      const toggle = async (id, next) => {
        setBusy(id);
        try {
          await commit({ [id]: next });
        } finally {
          setBusy('');
        }
      };

/**
 * Move the elision tier. A tier is a budget table, not a switch: the host
 * answers with the state it actually holds, so the panel never guesses.
 */
const setDepth = async (id) => {
      setBusy('depth');
      try {
       await commit({}, id);
      } finally {
       setBusy('');
      }
};

      const setTierAll = async (definition, next) => {
        const current = state?.modes ?? [];
        const ids = definition.modes.filter((id) => current.some((mode) => mode.id === id && mode.available !== false));
        if (ids.length === 0) return;
        setBusy(definition.id);
        try {
          await commit(Object.fromEntries(ids.map((id) => [id, next])));
        } finally {
          setBusy('');
        }
      };

      const modes = state?.modes?.filter((mode) => mode.available !== false) ?? [];
      const onCount = (state?.modes ?? []).filter((mode) => mode.on && mode.available !== false).length;
      const totalCount = modes.length;
      const depthProps = {
       current: state?.elisionDepth ?? '',
       options: state?.depths ?? [],
       onPick: setDepth,
       busy: busy === 'depth',
       text,
      };

      return h('div', {
        style: {
          margin: '4px 0 2px', fontFamily: 'inherit',
          color: 'var(--dsw-alias-label-primary)',
        },
      },
      h('button', {
        type: 'button',
        onClick: () => setOpen((value) => !value),
        'aria-expanded': open ? 'true' : 'false',
        title: text.title,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          padding: '3px 9px', borderRadius: '999px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: '11px', lineHeight: '16px', cursor: 'pointer', font: 'inherit',
        },
      },
      h('span', {
        style: {
          width: '6px', height: '6px', borderRadius: '50%',
          background: error !== '' ? 'var(--dsw-alias-state-error-primary)'
            : (onCount > 0 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)'),
        },
      }),
      state === null && error === '' ? text.title : text.collapsed(onCount, totalCount),
      h('span', { style: { fontSize: '9px' } }, open ? '▾' : '▸'),
      ),
      open ? h('div', {
        style: {
          marginTop: '6px', padding: '10px', borderRadius: '10px',
          // A definite width is required: this panel's dock wrapper sizes to
          // its content (max-content), and an auto-repeat grid template sizes as
          // a single repetition there, which is what collapsed the modes to one
          // column. The width formula also keeps the card inside the viewport.
          width: 'min(640px, calc(100vw - 48px))', maxWidth: '100%',
          boxSizing: 'border-box',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
        },
      },
      h('div', {
        style: {
          display: 'flex', alignItems: 'baseline',
          justifyContent: 'space-between', gap: '8px',
          marginBottom: '8px',
        },
      },
      h('span', { style: { fontSize: '12px', fontWeight: 600 } }, text.title),
      h('span', {
        style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' },
      }, text.hint),
      ),
      error !== '' ? h('div', {
        style: {
          margin: '0 0 8px', padding: '5px 8px', borderRadius: '6px',
          fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)',
          border: '1px solid var(--dsw-alias-state-error-primary)',
        },
      }, error) : null,
      h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '6px' },
      }, TIERS.map((definition) => h(TierBlock, {
        key: definition.id,
        depth: definition.id === 'advanced' ? depthProps : undefined,
        tier: definition,
        open: tier === definition.id,
        onToggle: (id) => setTier((current) => (current === id ? '' : id)),
        onSetAll: setTierAll,
        modes: state?.modes ?? [],
        text,
        busy,
        onToggleMode: toggle,
      }))),
      h('div', {
        style: {
          marginTop: '8px', paddingTop: '6px', fontSize: '10px',
          color: 'var(--dsw-alias-label-secondary)',
          borderTop: '1px solid var(--dsw-alias-border-l1)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        },
      }, text.statsHint),
      h('div', {
        style: {
          marginTop: '2px', fontSize: '10px', color: 'var(--dsw-alias-label-secondary)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        },
      }, state?.profileDir ? `${text.savedTo} ${state.profileDir}` : text.notSaved),
      ) : null,
      );
    }

    /** One bordered card in the settings page. */
    function Card(props) {
      return h('div', {
        style: {
          padding: '12px 14px', borderRadius: '10px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-2)',
          minWidth: 0,
        },
      }, props.children);
    }

    /** One label/value pair inside a card. */
    function Line(props) {
      const { label, value, accent } = props;
      return h('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          gap: '12px', padding: '3px 0', minWidth: 0,
        },
      },
      h('span', {
        style: { flex: '0 0 auto', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      }, label),
      h('span', {
        style: {
          // A statistics-file path is far longer than its label, so the value is
          // the side that shrinks and wraps rather than overflowing the card.
          flex: '0 1 auto', minWidth: 0, textAlign: 'right', overflowWrap: 'anywhere',
          fontSize: '12px', fontVariantNumeric: 'tabular-nums',
          color: accent === true ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-primary)',
        },
      }, value),
      );
    }

    /** A share bar for the saved ratio. */
    function Bar(props) {
      const ratio = Math.min(1, number(props.ratio));
      return h('div', {
        style: {
          height: '4px', borderRadius: '2px', marginTop: '8px',
          // The theme ships no third layer token, so the empty part of the bar is
          // the subtle border colour rather than an invented variable.
          background: 'var(--dsw-alias-border-l1)', overflow: 'hidden',
        },
      }, h('div', {
        style: {
          width: `${(ratio * 100).toFixed(1)}%`, height: '100%',
          background: 'var(--dsw-alias-brand-primary)',
        },
      }));
    }

    /** One column of the side-by-side scope comparison. */
    function ScopeCard(props) {
      const { title, summary, text } = props;
      return h('div', {
        style: {
          flex: '1 1 240px', minWidth: 0, padding: '12px 14px', borderRadius: '10px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-2)',
        },
      },
      h('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px',
          marginBottom: '4px',
        },
      },
      h('span', { style: { fontSize: '12px', fontWeight: 600 } }, title),
      h('span', {
        style: {
          fontSize: '16px', fontWeight: 600, fontVariantNumeric: 'tabular-nums',
          color: 'var(--dsw-alias-label-primary)',
        },
      }, compact(summary.savedTokens)),
      ),
      h(Line, { label: text.calls, value: compact(summary.calls) }),
      h(Line, { label: text.rewritten, value: compact(summary.rewritten) }),
      h(Line, { label: text.elided, value: compact(summary.elided) }),
        h(Line, { label: text.aged, value: compact(summary.aged ?? 0) }),
      h(Line, { label: text.saved, value: `${compact(summary.savedChars)} / ${compact(summary.before)}` }),
      h(Line, { label: text.ratio, value: percent(summary.savedRatio), accent: true }),
      h(Bar, { ratio: summary.savedRatio }),
      );
    }

    /** The token-saving page inside Settings. */
    function StatsPage() {
      const text = TEXT[PANEL_LOCALE] ?? TEXT.en;
      const stats = text.stats;
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [confirming, setConfirming] = React.useState(false);

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(STATS_ENDPOINT, { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setData(await response.json());
          setError('');
        } catch (failure) {
          setError(`${stats.failed}: ${String(failure?.message ?? failure)}`);
        }
      }, [stats]);

      React.useEffect(() => { load(); }, [load]);
      // The record grows while the page is open, so follow it without a reload.
      React.useEffect(() => {
        const timer = setInterval(() => { load(); }, 5000);
        return () => { clearInterval(timer); };
      }, [load]);

      const reset = async () => {
        setConfirming(false);
        setBusy(true);
        try {
          const response = await fetch(STATS_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reset: true }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setData(await response.json());
          setError('');
        } catch (failure) {
          setError(`${stats.failed}: ${String(failure?.message ?? failure)}`);
        } finally {
          setBusy(false);
        }
      };

      const button = (label, onClick, disabled) => h('button', {
        type: 'button',
        disabled: disabled === true,
        onClick,
        style: {
          padding: '4px 10px', borderRadius: '6px', font: 'inherit',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
          fontSize: '11px', lineHeight: '16px',
          cursor: disabled === true ? 'default' : 'pointer',
          opacity: disabled === true ? 0.6 : 1,
        },
      }, label);

      const cumulative = data?.cumulative ?? null;
      const session = data?.session ?? null;
      const tools = Array.isArray(data?.tools) ? data.tools.filter((row) => number(row.savedChars) > 0) : [];

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: '12px',
          maxWidth: '760px', padding: '4px 0 16px',
          fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary)',
        },
      },
      h('div', null,
        h('div', { style: { fontSize: '15px', fontWeight: 600 } }, stats.title),
        h('div', {
          style: { marginTop: '2px', fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
        }, stats.subtitle),
      ),
      error !== '' ? h('div', {
        style: {
          padding: '6px 9px', borderRadius: '6px', fontSize: '11px',
          color: 'var(--dsw-alias-state-error-primary)',
          border: '1px solid var(--dsw-alias-state-error-primary)',
        },
      }, error) : null,
      h(Card, null,
        h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, stats.hero),
        h('div', {
          style: {
            marginTop: '2px', fontSize: '28px', fontWeight: 600, lineHeight: '34px',
            fontVariantNumeric: 'tabular-nums',
          },
        }, compact(cumulative?.savedTokens ?? 0)),
        h('div', {
          style: { marginTop: '2px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
        }, stats.heroSub(compact(cumulative?.savedChars ?? 0))),
      ),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px' } },
        h(ScopeCard, { title: stats.session, summary: session ?? {}, text: stats }),
        h(ScopeCard, { title: stats.cumulative, summary: cumulative ?? {}, text: stats }),
      ),
      h(Card, null,
        h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px' } }, stats.byTool),
        tools.length === 0
          ? h('div', {
            style: { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
          }, stats.empty)
          : h('div', {
            style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto auto auto', gap: '4px 10px' },
          },
          ...[stats.tool, stats.tokens, stats.rewritten, stats.calls, stats.ratio].map((heading) => h('div', {
            key: `h-${heading}`,
            style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' },
          }, heading)),
          ...tools.slice(0, 12).flatMap((row) => [
            h('div', {
              key: `${row.tool}-name`,
              style: {
                minWidth: 0, fontSize: '11px', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, row.tool),
            h('div', {
              key: `${row.tool}-tokens`,
              style: { fontSize: '11px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-state-success-primary)' },
            }, compact(row.savedTokens)),
            h('div', {
              key: `${row.tool}-rewritten`,
              style: { fontSize: '11px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)' },
            }, compact(row.rewritten)),
            h('div', {
              key: `${row.tool}-calls`,
              style: { fontSize: '11px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)' },
            }, compact(row.calls)),
            h('div', {
              key: `${row.tool}-ratio`,
              style: { fontSize: '11px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)' },
            }, percent(row.savedRatio)),
          ]),
          ),
      ),
      h(Card, null,
        h(Line, { label: stats.catalogue, value: compact(cumulative?.catalogueTools ?? 0), accent: (cumulative?.catalogueTools ?? 0) > 0 }),
        h('div', {
          style: { marginTop: '4px', fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
        }, stats.catalogueDetail(compact(cumulative?.catalogueTools ?? 0), compact(cumulative?.catalogueTokens ?? 0))),
        h('div', {
          style: {
            marginTop: '8px', paddingTop: '6px',
            borderTop: '1px solid var(--dsw-alias-border-l1)',
          },
        },
        h(Line, { label: stats.recall, value: compact(cumulative?.recallInjections ?? 0) }),
        h(Line, { label: stats.recallChars, value: compact(cumulative?.recallChars ?? 0) }),
        h(Line, { label: stats.spillFailures, value: compact(cumulative?.spillFailures ?? 0) }),
        h(Line, { label: stats.aged, value: compact(cumulative?.aged ?? 0) }),
        ),
      ),
      h(Card, null,
        h('div', {
          style: { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
        }, stats.note),
        h('div', {
          style: { marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '12px' },
        },
        h(Line, { label: stats.file, value: data?.statsFile ?? stats.none }),
        h(Line, { label: stats.generated, value: stamp(data?.generatedAt) }),
        ),
        h('div', { style: { marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          button(stats.refresh, () => { load(); }, false),
          confirming
            ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
              h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)' } }, stats.confirm),
              button(stats.confirmYes, () => { reset(); }, busy),
              button(stats.confirmNo, () => { setConfirming(false); }, false))
            : button(stats.reset, () => { setConfirming(true); }, busy || data === null),
        ),
      ),
      );
    }

    const copy = () => TEXT[PANEL_LOCALE] ?? TEXT.en;

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-token-frugal-modes',
          order: 20,
          label: () => copy().title,
        }, TokenFrugalPanel));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-token-frugal',
          order: 60,
          label: () => copy().stats.nav,
        }, StatsPage));
      },
    };
  },
});

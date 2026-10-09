/**
 * Client half of `dsh-token-frugal`: the saving-mode panel under the composer.
 *
 * The browser artifact is a lazy factory whose id equals the package name, so
 * the page's module table hands it React and nothing else. It mounts into
 * `conversation.composer.dock` ("ambient entries below the composer card") and
 * talks to the Host half over the exact HTTP route the Host half registers —
 * the bridge a profile-installed bundle can actually use.
 *
 * Visible text follows the active locale read from the Client `locale` service;
 * every colour comes from a `--dsw-alias-*` theme token, so light and dark both
 * read correctly without a second stylesheet.
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-frugal',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** The Host half's route; kept in one place so both halves agree. */
    const ENDPOINT = '/dsh-token-frugal/modes';

    /** Mode copy, keyed by locale. */
    const TEXT = {
      en: {
        title: 'Token savings',
        collapsed: (on, total) => `${on}/${total} savings on`,
        hint: 'Applied to this session immediately; no restart.',
        terminal: ['Terminal noise', 'Strip ANSI escapes and carriage-return repaints.'],
        columns: ['Column padding', 'Collapse alignment padding, keeping indentation.'],
        repeatedLines: ['Repeated lines', 'Fold runs of identical lines into a count.'],
        numericRuns: ['Counting runs', 'Fold build counters and timestamps into a range.'],
        json: ['JSON', 'Minify JSON and tabulate homogeneous arrays.'],
        elide: ['Head/tail trim', 'Bound oversized results; every cut names a recovery path.'],
        catalogue: ['Tool catalogue', 'Hide tools you do not want offered to the model.'],
        memo: ['Session memory', 'Record your inputs and turn digests into the workspace.'],
        recall: ['Recall', 'Match a new message against that memory and inject the hits.'],
        unavailable: 'not configured',
        savedTo: 'Saved to',
        notSaved: 'Not persisted (no profile directory found)',
        failed: 'Could not reach the plugin',
      },
      zh: {
        title: 'Token 节省',
        collapsed: (on, total) => `已开 ${on}/${total} 项节省`,
        hint: '立即对当前会话生效，无需重启。',
        terminal: ['终端噪声', '清理 ANSI 转义与回车覆盖重绘。'],
        columns: ['列对齐空白', '折叠对齐用的连续空格，保留缩进。'],
        repeatedLines: ['重复行', '把连续相同的行折叠成计数。'],
        numericRuns: ['递增序列', '把构建计数、时间戳折成区间。'],
        json: ['JSON', '压缩 JSON，把同构数组转成表格。'],
        elide: ['头尾裁剪', '超预算结果裁到上限，每次裁剪都给出恢复路径。'],
        catalogue: ['工具目录', '隐藏你不想让模型看到的工具。'],
        memo: ['会话记忆', '把你的输入与每轮要点记进工作区。'],
        recall: ['记忆召回', '用新消息匹配记忆并注入命中的片段。'],
        unavailable: '未配置',
        savedTo: '保存到',
        notSaved: '未持久化（找不到 profile 目录）',
        failed: '无法连接到插件',
      },
    };

    /** Read the active locale defensively: any shape we cannot read is English. */
    function activeLocale(ctx) {
      try {
        const service = ctx === undefined ? undefined : ctx.get('locale');
        const snapshot = service?.getLocale?.() ?? service?.getSnapshot?.();
        const id = typeof snapshot === 'string' ? snapshot : (snapshot?.id ?? snapshot?.locale ?? snapshot?.current ?? '');
        return String(id).toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch {
        return 'en';
      }
    }

    /** One accessible switch row. */
    function ModeRow(props) {
      const { id, on, available, text, busy, onToggle } = props;
      const [label, description] = text[id] ?? [id, ''];
      return h('div', {
        style: {
          display: 'flex', alignItems: 'flex-start', gap: '10px',
          padding: '7px 10px', borderRadius: '8px',
          opacity: available === false ? 0.55 : 1,
        },
      },
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          'aria-label': label,
          disabled: available === false || busy === id,
          onClick: () => onToggle(id, !on),
          style: {
            flex: '0 0 auto', marginTop: '2px', width: '32px', height: '18px',
            borderRadius: '9px', border: '1px solid var(--dsw-alias-border-l2)',
            background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
            cursor: available === false ? 'default' : 'pointer',
            position: 'relative', padding: 0, transition: 'background 120ms ease',
          },
        }, h('span', {
          style: {
            position: 'absolute', top: '1px', left: on ? '15px' : '1px',
            width: '14px', height: '14px', borderRadius: '50%',
            background: 'var(--dsw-alias-bg-base)', transition: 'left 120ms ease',
          },
        })),
        h('div', { style: { minWidth: 0 } },
          h('div', {
            style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-primary)' },
          }, label, available === false ? h('span', {
            style: { marginLeft: '6px', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' },
          }, `(${text.unavailable})`) : null),
          h('div', {
            style: { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
          }, description),
        ),
      );
    }

    /**
     * The dock entry: a collapsed count that expands into the mode list.
     * @param props - slot props; unused beyond React's own bookkeeping.
     * @returns the panel element.
     */
    function TokenFrugalPanel(props) {
      const ctx = props?.ctx ?? panelContext;
      const [locale, setLocale] = React.useState(() => activeLocale(ctx));
      const [state, setState] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');

      const text = TEXT[locale] ?? TEXT.en;

      React.useEffect(() => {
        let service;
        try {
          service = ctx === undefined ? undefined : ctx.get('locale');
        } catch {
          service = undefined;
        }
        if (service?.subscribe === undefined) return undefined;
        const stop = service.subscribe(() => setLocale(activeLocale(ctx)));
        return typeof stop === 'function' ? stop : undefined;
      }, [ctx]);

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

      const toggle = async (id, next) => {
        setBusy(id);
        // Optimistic: the panel answers immediately and reverts on failure.
        const previous = state;
        setState((current) => current === null ? current : {
          ...current,
          modes: current.modes.map((mode) => (mode.id === id ? { ...mode, on: next } : mode)),
        });
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ modes: { [id]: next } }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setState(await response.json());
          setError('');
        } catch (failure) {
          setState(previous);
          setError(`${text.failed}: ${String(failure?.message ?? failure)}`);
        } finally {
          setBusy('');
        }
      };

      const modes = state?.modes?.filter((mode) => mode.available !== false) ?? [];
      const onCount = (state?.modes ?? []).filter((mode) => mode.on && mode.available !== false).length;
      const totalCount = modes.length;

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
            fontSize: '11px', lineHeight: '16px', cursor: 'pointer',
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
            marginTop: '6px', padding: '8px 4px 6px', borderRadius: '10px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        },
          h('div', {
            style: {
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
              padding: '0 10px 4px', gap: '8px',
            },
          },
            h('span', { style: { fontSize: '11px', fontWeight: 600 } }, text.title),
            h('span', { style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' } }, text.hint),
          ),
          error !== '' ? h('div', {
            style: {
              margin: '0 10px 6px', padding: '5px 8px', borderRadius: '6px', fontSize: '11px',
              color: 'var(--dsw-alias-state-error-primary)',
              border: '1px solid var(--dsw-alias-state-error-primary)',
            },
          }, error) : null,
          (state?.modes ?? []).map((mode) => h(ModeRow, {
            key: mode.id, id: mode.id, on: mode.on, available: mode.available,
            text, busy, onToggle: toggle,
          })),
          h('div', {
            style: {
              padding: '4px 10px 0', fontSize: '10px',
              color: 'var(--dsw-alias-label-secondary)',
              borderTop: '1px solid var(--dsw-alias-border-l1)', marginTop: '4px',
            },
          }, state?.profileDir ? `${text.savedTo} ${state.profileDir}` : text.notSaved),
        ) : null,
      );
    }

    /** Set by `apply`, so the component can read Client services without props. */
    let panelContext;

    return {
      inject: ['slots'],
      apply(ctx) {
        panelContext = ctx;
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-token-frugal-modes',
          order: 20,
          label: () => TEXT[activeLocale(ctx)]?.title ?? 'Token savings',
        }, TokenFrugalPanel));
      },
    };
  },
});

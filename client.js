/**
 * Client half of `dsh-token-frugal`: the saving-mode panel under the composer.
 *
 * The browser artifact is a lazy factory whose id equals the package name, so
 * the page's module table hands it React and nothing else. It mounts into
 * `conversation.composer.dock` ("ambient entries below the composer card") and
 * talks to the Host half over the exact HTTP route the Host half registers —
 * the bridge a profile-installed bundle can actually use.
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

    /** The Host half's route; kept in one place so both halves agree. */
    const ENDPOINT = '/dsh-token-frugal/modes';

    /**
     * Panel copy, keyed by locale. Plain words only: every line is read by the
     * person deciding whether to keep a saving on, not by a developer.
     */
    const TEXT = {
      en: {
        title: 'Token savings',
        collapsed: (on, total) => `${on}/${total} on`,
        hint: 'Applies at once, no restart.',
        terminal: ['Colour codes', 'Colour and cursor codes in command output'],
        columns: ['Padding', 'Runs of spaces that only line things up'],
        repeatedLines: ['Repeated lines', 'The same line over and over, kept once'],
        numericRuns: ['Rising numbers', 'Endless counters folded into from-to'],
        json: ['JSON', 'Verbose JSON flattened, arrays laid out as tables'],
        elide: ['Trim long output', 'Keep the start and end, the rest re-readable'],
        catalogue: ['Hide tools', 'Tools you do not need, out of sight'],
        memo: ['Session memory', 'What you said, plus each turn, saved to a file'],
        recall: ['Recall', 'When a new message matches, the match rides along'],
        unavailable: 'off',
        savedTo: 'settings in',
        notSaved: 'not saved (no config folder found)',
        failed: 'Could not reach the plugin',
      },
      zh: {
        title: '省 Token',
        collapsed: (on, total) => `已开 ${on}/${total} 项`,
        hint: '改完立刻生效，不用重启。',
        terminal: ['颜色码', '命令行里的上色和光标控制符，模型看不懂'],
        columns: ['多余空格', '为了对齐打的一长串空格，压成一个'],
        repeatedLines: ['重复的行', '连着重复的同一行，只留一行加次数'],
        numericRuns: ['递增的数字', '一直往上涨的计数，折成从多少到多少'],
        json: ['JSON', '啰嗦的 JSON 压扁，规整的数组摆成表格'],
        elide: ['太长就截', '只留开头和结尾，删掉的部分能读回来'],
        catalogue: ['藏起工具', '用不上的工具藏起来，模型看不到就不浪费'],
        memo: ['会话记忆', '你说过的话和每轮要点，自动记进一个文件'],
        recall: ['找回记忆', '新消息对得上时，把相关片段一起带上'],
        unavailable: '没开启',
        savedTo: '设置存在',
        notSaved: '没保存（没找到配置目录）',
        failed: '连不上插件',
      },
    };

    /**
     * Panel language. Pinned to Chinese on purpose: this panel's audience is the
     * profile's user, and the Client `locale` service could not be read reliably
     * from a profile-installed bundle, so following it meant silently falling
     * back to English. Set this to 'en' to switch the whole panel back.
     */
    const PANEL_LOCALE = 'zh';

    /** One mode, as a cell of the panel grid. */
    function ModeRow(props) {
      const { id, on, available, text, busy, onToggle } = props;
      const [label, description] = text[id] ?? [id, ''];
      const disabled = available === false || busy === id;
      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: '3px',
          padding: '8px 10px', borderRadius: '8px', minWidth: 0,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-2)',
          opacity: available === false ? 0.55 : 1,
        },
      },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', gap: '8px',
          },
        },
          h('span', {
            style: {
              fontSize: '12px', lineHeight: '16px',
              color: 'var(--dsw-alias-label-primary)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            },
          }, label, available === false ? h('span', {
            style: {
              marginLeft: '4px', fontSize: '10px',
              color: 'var(--dsw-alias-label-secondary)',
            },
          }, `(${text.unavailable})`) : null),
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': on ? 'true' : 'false',
            'aria-label': label,
            disabled,
            onClick: () => onToggle(id, !on),
            style: {
              flex: '0 0 auto', width: '32px', height: '18px',
              borderRadius: '9px', border: '1px solid var(--dsw-alias-border-l2)',
              background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-3)',
              cursor: disabled ? 'default' : 'pointer',
              position: 'relative', padding: 0, transition: 'background 120ms ease',
            },
          }, h('span', {
            style: {
              position: 'absolute', top: '1px', left: on ? '15px' : '1px',
              width: '14px', height: '14px', borderRadius: '50%',
              background: 'var(--dsw-alias-bg-base)', transition: 'left 120ms ease',
            },
          })),
        ),
        h('div', {
          style: {
            fontSize: '11px', lineHeight: '15px',
            color: 'var(--dsw-alias-label-secondary)',
          },
        }, description),
      );
    }

    /**
     * The dock entry: a collapsed count that expands into the mode grid.
     * @returns the panel element.
     */
    function TokenFrugalPanel() {
      const [state, setState] = React.useState(null);
      const [open, setOpen] = React.useState(false);
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
            marginTop: '6px', padding: '10px', borderRadius: '10px',
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
            style: {
              display: 'grid', gap: '6px',
              gridTemplateColumns: 'repeat(auto-fit, minmax(215px, 1fr))',
            },
          }, (state?.modes ?? []).map((mode) => h(ModeRow, {
            key: mode.id, id: mode.id, on: mode.on, available: mode.available,
            text, busy, onToggle: toggle,
          }))),
          h('div', {
            style: {
              marginTop: '8px', paddingTop: '6px', fontSize: '10px',
              color: 'var(--dsw-alias-label-secondary)',
              borderTop: '1px solid var(--dsw-alias-border-l1)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            },
          }, state?.profileDir ? `${text.savedTo} ${state.profileDir}` : text.notSaved),
        ) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-token-frugal-modes',
          order: 20,
          label: () => TEXT[PANEL_LOCALE]?.title ?? 'Token savings',
        }, TokenFrugalPanel));
      },
    };
  },
});

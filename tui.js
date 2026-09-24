// Generated from tui.tsx by scripts/build-tui.ts. Do not edit.
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
// Sidebar block for opencode-cache-warmer: pi's `/session` cache warming line, warming spend,
// and cache misses, pushed live from the server plugin over RPC. Significant misses also toast,
// like pi's transcript notices.
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { Definition } from "./rpc.ts";
const usd = value => value < 0.01 && value > 0 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
const tokens = value => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
function countdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  return m > 0 ? `${m}m ${String(total % 60).padStart(2, "0")}s` : `${total}s`;
}
export default Plugin.define({
  id: "opencode-cache-warmer.sidebar",
  setup(context) {
    const rpc = context.client.rpc(Definition);
    // Latest snapshot per session, stamped with local receipt time to correct for clock skew.
    const [snapshots, setSnapshots] = createSignal({});
    const store = snap => setSnapshots(all => ({
      ...all,
      [snap.sessionID]: {
        ...snap,
        receivedAt: Date.now()
      }
    }));
    const off = rpc.events.on("update", event => {
      const snap = event.data;
      store(snap);
      if (snap.notice) context.ui.toast.show({
        variant: "warning",
        message: snap.notice,
        sessionID: snap.sessionID
      });
    });
    const [now, setNow] = createSignal(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    function Block(props) {
      const theme = context.theme;
      const snap = createMemo(() => snapshots()[props.sessionID]);

      // Fetch once per session shown; later changes arrive as events.
      createEffect(on(() => props.sessionID, sessionID => {
        const location = context.data.session.get(sessionID)?.location;
        rpc.status({
          sessionID
        }, location ? {
          location
        } : undefined).then(result => result && store(result)).catch(() => {});
      }));

      // Two short lines: the sidebar is narrow.
      const line = createMemo(() => {
        const s = snap();
        if (!s) return undefined;
        if (s.mode === "off") return "Warming off";
        if (s.state === "refreshing") return "Refreshing…";
        if (s.state === "scheduled" && s.nextWarmAt) {
          const localAt = s.nextWarmAt - s.serverNow + s.receivedAt;
          return `Refresh in ${countdown(localAt - now())} (${s.phase === "idle" ? "idle" : "running"})`;
        }
        return `Stopped: ${s.reason ?? "inactive"}`;
      });
      const detail = createMemo(() => {
        const s = snap();
        if (!s || s.state === "inactive" || s.expectedSavings === undefined) return undefined;
        return `expected saving ~${usd(Math.max(0, s.expectedSavings))}`;
      });
      return _$createComponent(Show, {
        get when() {
          return snap();
        },
        children: s => (() => {
          var _el$ = _$createElement("box"),
            _el$2 = _$createElement("text"),
            _el$3 = _$createElement("b"),
            _el$5 = _$createElement("text");
          _$insertNode(_el$, _el$2);
          _$insertNode(_el$, _el$5);
          _$insertNode(_el$2, _el$3);
          _$insertNode(_el$3, _$createTextNode(`Cache`));
          _$insert(_el$5, line);
          _$insert(_el$, _$createComponent(Show, {
            get when() {
              return detail();
            },
            get children() {
              var _el$6 = _$createElement("text");
              _$insert(_el$6, detail);
              _$effect(_$p => _$setProp(_el$6, "fg", theme.text.muted, _$p));
              return _el$6;
            }
          }), null);
          _$insert(_el$, _$createComponent(Show, {
            get when() {
              return s().warms.count > 0;
            },
            get children() {
              var _el$7 = _$createElement("text"),
                _el$8 = _$createTextNode(` `),
                _el$9 = _$createTextNode(` · `);
              _$insertNode(_el$7, _el$8);
              _$insertNode(_el$7, _el$9);
              _$insert(_el$7, () => s().warms.count, _el$8);
              _$insert(_el$7, () => s().warms.count === 1 ? "refresh" : "refreshes", _el$9);
              _$insert(_el$7, () => usd(s().warms.cost), null);
              _$effect(_$p => _$setProp(_el$7, "fg", theme.text.muted, _$p));
              return _el$7;
            }
          }), null);
          _$insert(_el$, _$createComponent(Show, {
            get when() {
              return s().misses.count > 0;
            },
            get children() {
              var _el$0 = _$createElement("text"),
                _el$1 = _$createTextNode(` `),
                _el$10 = _$createTextNode(` · `),
                _el$11 = _$createTextNode(` tokens · ~`);
              _$insertNode(_el$0, _el$1);
              _$insertNode(_el$0, _el$10);
              _$insertNode(_el$0, _el$11);
              _$insert(_el$0, () => s().misses.count, _el$1);
              _$insert(_el$0, () => s().misses.count === 1 ? "miss" : "misses", _el$10);
              _$insert(_el$0, () => tokens(s().misses.tokens), _el$11);
              _$insert(_el$0, () => usd(s().misses.cost), null);
              _$effect(_$p => _$setProp(_el$0, "fg", theme.text.feedback.warning.base, _$p));
              return _el$0;
            }
          }), null);
          _$effect(_p$ => {
            var _v$ = theme.text.base,
              _v$2 = theme.text.muted;
            _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
            _v$2 !== _p$.t && (_p$.t = _$setProp(_el$5, "fg", _v$2, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$;
        })()
      });
    }
    const release = context.ui.slot({
      append: "sidebar.content",
      render: props => _$createComponent(Block, {
        get sessionID() {
          return props.sessionID;
        }
      })
    });
    return () => {
      release();
      off();
      clearInterval(tick);
    };
  }
});

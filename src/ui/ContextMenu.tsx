/**
 * 右键菜单（极简：一个绝对定位的列表）。
 *
 * ## 为什么不用原生 contextmenu
 *
 * 原生菜单在 webview / 内嵌面板里行为不一致（有的直接不弹、有的弹浏览器菜单），
 * 而且我们需要的只是"两项以内的操作"。自己画一个 40 行的小菜单更可控。
 *
 * 关闭规则：点菜单外任意处 / 按 Esc / 选中某一项后自动关。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactElement } from 'react';

export interface ContextMenuAction {
  label: string;
  /** 危险操作（删除）用红色。 */
  danger?: boolean;
  /** 当前不可用（例如"分离音频"用在没有声音的片段上）——置灰但仍显示，并说明原因。 */
  disabled?: boolean;
  onSelect: () => void;
}

/** 分组分隔线：菜单超过 8 项以后，平铺一长条会让人找不到东西。 */
export interface ContextMenuSeparator {
  separator: true;
}

export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export function ContextMenu({
  state,
  onClose,
}: {
  state: ContextMenuState | null;
  onClose: () => void;
}): ReactElement | null {
  useEffect(() => {
    if (state === null) return;
    /**
     * 点菜单外面才关。
     *
     * **必须判 `contains`**：`pointerdown` 是捕获阶段监听的，它比菜单项的 `onClick` 先跑；
     * 如果无条件 onClose，菜单会在 pointerdown 那一刻被卸载 —— 随后的 click 落空，
     * 菜单项永远点不动（实测：右键菜单能看到，点"删除"没反应）。
     * 我的 E2E 之前用 `element.click()` 验证，绕过了 pointerdown，所以没发现这个 bug。
     */
    const close = (event: PointerEvent): void => {
      const menu = document.querySelector('[data-v="context-menu"]');
      if (menu !== null && event.target instanceof Node && menu.contains(event.target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    /**
     * **延迟一帧再挂监听**：右键的 pointerdown 与 contextmenu 是同一串事件，
     * 如果立刻挂"点外面关闭"，打开菜单的那次 pointerdown 会把它当场关掉 ——
     * 表现就是"有时候右键能开、有时候开不了"（实测连跑时随机失败）。
     * 放到 setTimeout(0) 里，等这一串事件走完再开始监听。
     */
    const timer = window.setTimeout(() => {
      window.addEventListener('pointerdown', close, true);
    }, 0);
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [state, onClose]);

  /** 修正后的位置（贴边时向上/向左翻，保证整张菜单都在视口内）。 */
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    setPos(null);
  }, [state]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu === null || state === null) return;
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    // 右侧/底部放不下就翻到另一侧：否则最后几项会落到视口外，
    // `elementFromPoint` 返回 null —— 菜单看得见、点不到（实测踩到）。
    const left = Math.max(margin, Math.min(state.x, window.innerWidth - rect.width - margin));
    const top =
      state.y + rect.height + margin > window.innerHeight
        ? Math.max(margin, state.y - rect.height)
        : state.y;
    setPos({ left, top });
  }, [state]);

  if (state === null) return null;

  /**
   * **必须挂到 document.body**（portal）。
   *
   * 菜单是从时间线/素材栏里渲染的，而这两块都有 `overflow: hidden`：
   * `position: fixed` 的元素超出祖先裁剪区后**看不见、也点不到**
   * （实测：4 项菜单最后一项的 `elementFromPoint` 返回 null，点了没反应）。
   * 挂到 body 上就不受任何祖先裁剪影响。
   */
  return createPortal(
    <div
      ref={menuRef}
      className="v-menu"
      data-v="context-menu"
      role="menu"
      style={{
        left: pos?.left ?? state.x,
        // 先按原位置渲染一次量高度，再修正；测量期间不可见避免闪一下
        top: pos?.top ?? state.y,
        visibility: pos === null ? 'hidden' : 'visible',
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {state.items.map((item, index) => {
        if ('separator' in item) {
          return <div key={`sep-${index}`} className="v-menu__sep" role="separator" />;
        }
        return (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={`v-menu__item${item.danger === true ? ' v-menu__item--danger' : ''}`}
            data-v={`context-${item.label}`}
            disabled={item.disabled === true}
            onClick={() => {
              if (item.disabled === true) return;
              item.onSelect();
              onClose();
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

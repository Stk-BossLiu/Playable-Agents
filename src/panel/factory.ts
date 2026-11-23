import { createApp, type Component } from 'vue';
import tokensCss from './tokens.css?inline';
import stylesCss from './styles.css?inline';
import App from './App.vue';
import BoardApp from './BoardApp.vue';
import ShellApp from './ShellApp.vue';
import StatusApp from './StatusApp.vue';
import { MessageName, PACKAGE_NAME } from '../shared/protocol';
import type { PanelEvent, PanelReadyPayload } from '../shared/types';
import { handlePanelEvent } from './store';

export type PanelView = 'board' | 'chat' | 'status' | 'shell';

type MountedApp = { unmount(): void };
type PanelSelf = {
  $?: { root?: HTMLElement };
};

const apps = new WeakMap<object, MountedApp>();

const COMPONENTS: Record<PanelView, Component> = {
  board: BoardApp,
  chat: App,
  status: StatusApp,
  shell: ShellApp,
};

async function requestMain<T>(message: string, ...args: unknown[]): Promise<T> {
  return (Editor.Message.request as unknown as (
    target: string,
    message: string,
    ...rest: unknown[]
  ) => Promise<T>)(PACKAGE_NAME, message, ...args);
}

export function createPanel(view: PanelView) {
  const rootSelector = `#cocos-ai-agent-root-${view}`;
  return Editor.Panel.define({
    template: `<div id="cocos-ai-agent-root-${view}" class="cocos-ai-agent-root"></div>`,
    style: `${tokensCss}\n${stylesCss}`,
    $: {
      root: rootSelector,
    },

    ready() {
      const self = this as unknown as PanelSelf;
      const root = self.$?.root;
      if (!root) {
        console.error(`[${PACKAGE_NAME}] ${view} panel root not found`);
        return;
      }
      const app = createApp(COMPONENTS[view]);
      app.mount(root);
      apps.set(self as object, app);

      const payload: PanelReadyPayload = {
        at: Date.now(),
        view,
        locale: navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en',
        theme: window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
      };
      const reportReady = (attempt = 0): void => {
        void requestMain<boolean>(MessageName.PanelReady, payload).catch((err) => {
          if (attempt < 8) {
            setTimeout(() => reportReady(attempt + 1), 250);
            return;
          }
          console.error(`[${PACKAGE_NAME}] ${view} panel-ready failed`, err);
        });
      };
      reportReady();
      console.log(`[${PACKAGE_NAME}] ${view} panel ready`);
    },

    close() {
      const self = this as unknown as PanelSelf;
      apps.get(self as object)?.unmount();
      apps.delete(self as object);
      void requestMain<boolean>(MessageName.PanelClosed, { view }).catch(() => undefined);
      console.log(`[${PACKAGE_NAME}] ${view} panel closed`);
    },

    methods: {
      onPanelEvent(event: PanelEvent): void {
        (window as unknown as { __cocosAiAgentLastEvent?: PanelEvent }).__cocosAiAgentLastEvent = event;
        handlePanelEvent(event);
      },
    },
  });
}

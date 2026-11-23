import { MainController } from './controller';

export const controller = new MainController();
export const methods = controller.methods;

export async function load(): Promise<void> {
  await controller.load();
}

export async function beforeUnload(): Promise<boolean> {
  return controller.beforeUnload();
}

export async function unload(): Promise<void> {
  await controller.unload();
}

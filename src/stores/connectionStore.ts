// 连接展示状态（F-0014）：只放目标、身份、能力、重连倒计时等界面需要的数据。
// 每个客户端 Context 一份；真正拥有连接的是 HostSessionController。
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ConnectionSnapshot } from '@/runtime/connectionModel';

export type ConnectionState = ConnectionSnapshot;

export const createConnectionStore = (initial: ConnectionSnapshot = { phase: 'boot', attempt: 0 }): StoreApi<ConnectionState> =>
  createStore<ConnectionState>()(() => initial);

export const EMPTY_CONNECTION: ConnectionSnapshot = { phase: 'boot', attempt: 0 };

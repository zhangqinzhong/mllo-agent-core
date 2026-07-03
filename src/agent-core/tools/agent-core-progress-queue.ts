export type AgentCoreProgressQueue<T> = {
  push: (value: T) => void
  close: () => void
  next: () => Promise<T | null>
}

// 创建单生产者进度队列。工具进程回调推事件，编排层用 async race 消费。
export function createAgentCoreProgressQueue<T>(): AgentCoreProgressQueue<T> {
  const values: T[] = []
  const waiters: ((value: T | null) => void)[] = []
  let closed = false

  // 唤醒一个等待者。没有等待者时，事件留在队列里等下一次 next。
  function flush(): void {
    const waiter = waiters.shift()
    if (waiter === undefined) {
      return
    }
    const value = values.shift()
    if (value !== undefined) {
      waiter(value)
      return
    }
    if (closed) {
      waiter(null)
      return
    }
    waiters.unshift(waiter)
  }

  return {
    push(value) {
      if (closed) {
        return
      }
      values.push(value)
      flush()
    },
    close() {
      closed = true
      while (waiters.length > 0) {
        flush()
      }
    },
    async next() {
      const value = values.shift()
      if (value !== undefined) {
        return value
      }
      if (closed) {
        return null
      }
      return await new Promise<T | null>((resolve) => {
        waiters.push(resolve)
      })
    }
  }
}

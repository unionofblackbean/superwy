const { EventEmitter } = require('events');
const { AsyncLocalStorage } = require('async_hooks');

class TaskCancelledError extends Error {
    constructor(message = '任务已终止') {
        super(message);
        this.name = 'TaskCancelledError';
        this.code = 'TASK_QUEUE_CANCELLED';
    }
}

class TaskQueue extends EventEmitter {
    constructor() {
        super();
        this.pending = [];
        this.currentTask = null;
        this.history = [];
        this.maxHistory = 20;
        this.nextTaskId = 1;
        this.processing = false;
        this.asyncLocalStorage = new AsyncLocalStorage();
    }

    enqueueTask({ type = 'generic', title = '未命名任务', meta = {}, executor }) {
        if (typeof executor !== 'function') {
            return Promise.reject(new Error('任务执行器必须是函数'));
        }

        const activeContext = this.asyncLocalStorage.getStore();
        if (activeContext) {
            return Promise.resolve().then(() => executor(activeContext.helpers));
        }

        return new Promise((resolve, reject) => {
            const task = {
                id: this.nextTaskId++,
                type,
                title,
                meta,
                status: 'pending',
                createdAt: Date.now(),
                startedAt: null,
                finishedAt: null,
                error: '',
                cancelReason: '',
                cancelHandler: null,
                abortController: null,
                resolve,
                reject,
                executor
            };

            this.pending.push(task);
            this.emitChange();
            void this.processQueue();
        });
    }

    isTaskCancelledError(error) {
        return Boolean(error) && (error instanceof TaskCancelledError || error.code === 'TASK_QUEUE_CANCELLED');
    }

    terminateAll(reason = '任务队列已终止') {
        const pendingTasks = this.pending.splice(0);
        const finishedAt = Date.now();

        for (const task of pendingTasks) {
            const error = new TaskCancelledError(reason);
            task.status = 'cancelled';
            task.error = error.message;
            task.finishedAt = finishedAt;
            task.reject(error);
            this.pushHistory(task);
        }

        if (this.currentTask) {
            this.currentTask.cancelReason = reason;
            if (this.currentTask.abortController && !this.currentTask.abortController.signal.aborted) {
                this.currentTask.abortController.abort();
            }
            if (typeof this.currentTask.cancelHandler === 'function') {
                try {
                    this.currentTask.cancelHandler();
                } catch (error) {
                    console.warn('[任务队列] 终止当前任务失败:', error.message);
                }
            }
        }

        this.emitChange();
    }

    async processQueue() {
        if (this.processing) {
            return;
        }

        this.processing = true;
        try {
            while (this.pending.length > 0) {
                const task = this.pending.shift();
                this.currentTask = task;
                task.status = 'running';
                task.startedAt = Date.now();
                task.abortController = new AbortController();
                this.emitChange();

                const helpers = {
                    task,
                    signal: task.abortController.signal,
                    throwIfAborted: () => {
                        if (task.abortController.signal.aborted) {
                            throw new TaskCancelledError(task.cancelReason || '任务已终止');
                        }
                    },
                    setCancel: (cancelHandler) => {
                        const previous = task.cancelHandler;
                        task.cancelHandler = typeof cancelHandler === 'function' ? cancelHandler : null;
                        return () => {
                            if (task.cancelHandler === cancelHandler) {
                                task.cancelHandler = previous;
                            }
                        };
                    }
                };

                try {
                    const result = await this.asyncLocalStorage.run({ helpers }, () => task.executor(helpers));
                    helpers.throwIfAborted();
                    task.status = 'completed';
                    task.resolve(result);
                } catch (error) {
                    if (this.isTaskCancelledError(error) || task.abortController.signal.aborted) {
                        const cancelledError = this.isTaskCancelledError(error)
                            ? error
                            : new TaskCancelledError(task.cancelReason || '任务已终止');
                        task.status = 'cancelled';
                        task.error = cancelledError.message;
                        task.reject(cancelledError);
                    } else {
                        task.status = 'failed';
                        task.error = error && error.message ? error.message : String(error);
                        task.reject(error);
                    }
                } finally {
                    task.finishedAt = Date.now();
                    task.cancelHandler = null;
                    task.abortController = null;
                    this.pushHistory(task);
                    this.currentTask = null;
                    this.emitChange();
                }
            }
        } finally {
            this.processing = false;
            if (this.pending.length > 0) {
                void this.processQueue();
            }
        }
    }

    pushHistory(task) {
        this.history.unshift(task);
        if (this.history.length > this.maxHistory) {
            this.history.length = this.maxHistory;
        }
    }

    serializeTask(task) {
        if (!task) {
            return null;
        }

        return {
            id: task.id,
            type: task.type,
            title: task.title,
            source: task.meta && task.meta.source ? task.meta.source : '',
            target: task.meta && task.meta.target ? task.meta.target : '',
            status: task.status,
            error: task.error || '',
            createdAt: task.createdAt,
            startedAt: task.startedAt,
            finishedAt: task.finishedAt
        };
    }

    getState() {
        const runningTask = this.serializeTask(this.currentTask);
        const pending = this.pending.map((task) => this.serializeTask(task));
        const history = this.history.map((task) => this.serializeTask(task));

        return {
            runningTask,
            pending,
            history,
            tasks: [runningTask, ...pending, ...history].filter(Boolean),
            stats: {
                running: runningTask ? 1 : 0,
                pending: pending.length,
                completed: history.filter((task) => task.status === 'completed').length,
                failed: history.filter((task) => task.status === 'failed').length,
                cancelled: history.filter((task) => task.status === 'cancelled').length
            },
            updatedAt: Date.now()
        };
    }

    emitChange() {
        this.emit('change', this.getState());
    }
}

const taskQueue = new TaskQueue();

module.exports = taskQueue;
module.exports.TaskCancelledError = TaskCancelledError;
// Keep an exported helper without overriding the instance method on taskQueue.
module.exports.isTaskCancelledError = (error) => TaskQueue.prototype.isTaskCancelledError.call(taskQueue, error);
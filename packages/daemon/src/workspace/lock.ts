/**
 * A mutex keyed by string. One lock per worktree.
 *
 * TRACK C owns this file.
 *
 * Why a worktree needs a lock: `git worktree add`, `git worktree remove`, a
 * `PUT /file` write and the watcher's `git diff` all touch the same checkout and
 * the same index. Two of those overlapping produce `index.lock` errors at best
 * and a half-created worktree at worst. Node is single-threaded but every one of
 * these operations awaits, so overlap is the default, not the exception.
 *
 * Per-KEY and not global on purpose: work in two different jobs must not queue
 * behind each other, or one slow repo stalls the fleet.
 */

type Release = () => void;

export class KeyedLock {
  /** Tail of the promise chain per key. Absent key = uncontended. */
  #tails = new Map<string, Promise<void>>();

  /** Await your turn, then call the returned release exactly once. */
  async acquire(key: string): Promise<Release> {
    const previous = this.#tails.get(key) ?? Promise.resolve();

    let finish!: () => void;
    const mine = new Promise<void>((resolveTurn) => {
      finish = resolveTurn;
    });

    // The tail every later caller waits on: previous work, then mine.
    const chained = previous.then(() => mine);
    this.#tails.set(key, chained);

    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Last one out clears the key, so the map doesn't grow forever. If someone
      // queued behind us they already replaced the tail — leave theirs alone.
      if (this.#tails.get(key) === chained) this.#tails.delete(key);
      finish();
    };
  }

  /** The form you actually want: the lock is released even if `fn` throws. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get held(): number {
    return this.#tails.size;
  }
}

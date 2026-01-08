/**
 * SMI-1189: Typed Event Emitter
 *
 * Generic TypedEventEmitter that provides type-safe event handling.
 * Replaces ~182 lines of repetitive type overloads with a single generic class.
 */

import { EventEmitter } from 'node:events'

/**
 * Constraint type for event maps.
 * Events must be a record of event names to argument tuples.
 */
export type EventMap = { [K: string]: unknown[] }

/**
 * Type-safe EventEmitter wrapper.
 *
 * @typeParam Events - Object mapping event names to their argument tuples
 *
 * @example
 * ```typescript
 * interface MyEvents {
 *   data: [payload: string];
 *   error: [error: Error, code: number];
 *   complete: [];
 * }
 *
 * class MyEmitter extends TypedEventEmitter<MyEvents> {
 *   doSomething() {
 *     this.emit('data', 'hello');  // Type-checked!
 *     this.emit('error', new Error('oops'), 500);
 *   }
 * }
 * ```
 */
export class TypedEventEmitter<Events extends EventMap> extends EventEmitter {
  /**
   * Adds a listener function to the end of the listeners array for the specified event.
   */
  override on<K extends keyof Events & string>(
    event: K,
    listener: (...args: Events[K]) => void
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  /**
   * Synchronously calls each of the listeners registered for the event.
   */
  override emit<K extends keyof Events & string>(event: K, ...args: Events[K]): boolean {
    return super.emit(event, ...args)
  }

  /**
   * Removes the specified listener from the listener array for the specified event.
   */
  override off<K extends keyof Events & string>(
    event: K,
    listener: (...args: Events[K]) => void
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void)
  }

  /**
   * Adds a one-time listener function for the specified event.
   */
  override once<K extends keyof Events & string>(
    event: K,
    listener: (...args: Events[K]) => void
  ): this {
    return super.once(event, listener as (...args: unknown[]) => void)
  }

  /**
   * Alias for on().
   */
  override addListener<K extends keyof Events & string>(
    event: K,
    listener: (...args: Events[K]) => void
  ): this {
    return super.addListener(event, listener as (...args: unknown[]) => void)
  }

  /**
   * Alias for off().
   */
  override removeListener<K extends keyof Events & string>(
    event: K,
    listener: (...args: Events[K]) => void
  ): this {
    return super.removeListener(event, listener as (...args: unknown[]) => void)
  }

  /**
   * Adds a listener to the beginning of the listeners array.
   */
  override prependListener<K extends keyof Events & string>(
    event: K,
    listener: (...args: Events[K]) => void
  ): this {
    return super.prependListener(event, listener as (...args: unknown[]) => void)
  }

  /**
   * Adds a one-time listener to the beginning of the listeners array.
   */
  override prependOnceListener<K extends keyof Events & string>(
    event: K,
    listener: (...args: Events[K]) => void
  ): this {
    return super.prependOnceListener(event, listener as (...args: unknown[]) => void)
  }
}

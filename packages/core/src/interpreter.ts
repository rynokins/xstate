import type {
  ActorContext,
  AnyActorRef,
  AnyState,
  AnyStateMachine,
  Behavior,
  EventFromBehavior,
  InterpreterFrom,
  SnapshotFrom
} from './types';
import { doneInvoke } from './actions';
import { startSignalType, stopSignalType } from './actors';
import { devToolsAdapter } from './dev';
import { IS_PRODUCTION } from './environment';
import { Mailbox } from './Mailbox';
import { registry } from './registry';
import { isStateConfig, State } from './State';
import { AreAllImplementationsAssumedToBeProvided } from './typegenTypes';
import type { PayloadSender } from './types';
import {
  ActorRef,
  DoneEvent,
  EventObject,
  InteropSubscribable,
  InterpreterOptions,
  Observer,
  SCXML,
  SendActionObject,
  StateValue,
  Subscription
} from './types';
import {
  isSCXMLErrorEvent,
  isStateLike,
  isStateMachine,
  toEventObject,
  toObserver,
  toSCXMLEvent,
  warn
} from './utils';
import { symbolObservable } from './symbolObservable';
import { execAction } from './exec';

export type SnapshotListener<TBehavior extends Behavior<any, any>> = (
  state: SnapshotFrom<TBehavior>
) => void;

export type EventListener<TEvent extends EventObject = EventObject> = (
  event: TEvent
) => void;

export type Listener = () => void;
export type ErrorListener = (error: any) => void;

export interface Clock {
  setTimeout(fn: (...args: any[]) => void, timeout: number): any;
  clearTimeout(id: any): void;
}

export enum InterpreterStatus {
  NotStarted,
  Running,
  Stopped
}

const defaultOptions = {
  deferEvents: true,
  clock: {
    setTimeout: (fn, ms) => {
      return setTimeout(fn, ms);
    },
    clearTimeout: (id) => {
      return clearTimeout(id);
    }
  } as Clock,
  logger: console.log.bind(console),
  devTools: false
};

type InternalStateFrom<
  TBehavior extends Behavior<any, any, any>
> = TBehavior extends Behavior<infer _, infer __, infer TInternalState>
  ? TInternalState
  : never;

export class Interpreter<
  TBehavior extends Behavior<any, any>,
  TEvent extends EventObject = EventFromBehavior<TBehavior>
> implements ActorRef<TEvent, SnapshotFrom<TBehavior>> {
  /**
   * The current state of the interpreted machine.
   */
  private _state?: InternalStateFrom<TBehavior>;
  /**
   * The clock that is responsible for setting and clearing timeouts, such as delayed events and transitions.
   */
  public clock: Clock;
  public options: Readonly<InterpreterOptions>;

  /**
   * The unique identifier for this actor relative to its parent.
   */
  public id: string;

  private mailbox: Mailbox<SCXML.Event<TEvent>> = new Mailbox(
    this._process.bind(this)
  );

  private delayedEventsMap: Record<string, unknown> = {};

  private observers: Set<Observer<SnapshotFrom<TBehavior>>> = new Set();
  private logger: (...args: any[]) => void;
  /**
   * Whether the service is started.
   */
  public status: InterpreterStatus = InterpreterStatus.NotStarted;

  // Actor Ref
  public _parent?: ActorRef<any>;
  public ref: ActorRef<TEvent>;
  private _actorContext: ActorContext<TEvent, SnapshotFrom<TBehavior>>;

  /**
   * The globally unique process ID for this invocation.
   */
  public sessionId: string;

  // TODO: remove
  public _forwardTo: Set<AnyActorRef> = new Set();

  /**
   * Creates a new Interpreter instance (i.e., service) for the given machine with the provided options, if any.
   *
   * @param behavior The machine to be interpreted
   * @param options Interpreter options
   */
  constructor(public behavior: TBehavior, options?: InterpreterOptions) {
    const resolvedOptions = {
      ...defaultOptions,
      ...options
    };

    const { clock, logger, parent, id } = resolvedOptions;
    const self = this;

    // TODO: this should come from a "system"
    this.sessionId = registry.bookId();
    this.id = id ?? this.sessionId;
    this.logger = logger;
    this.clock = clock;
    this._parent = parent;
    this.options = resolvedOptions;
    this.ref = this;
    this._actorContext = {
      self,
      id: this.id,
      sessionId: this.sessionId,
      logger: this.logger,
      exec: (fn) => {
        if (self.status === InterpreterStatus.NotStarted) {
          this._deferred.push(fn);
        } else {
          fn();
        }
      },
      defer: (fn) => {
        this._deferred.push(fn);
      },
      observers: this.observers
    };
  }

  // array of functions to defer
  private _deferred: Array<(state: any) => void> = [];

  private __initial: InternalStateFrom<TBehavior> | undefined = undefined;

  public get initialState(): InternalStateFrom<TBehavior> {
    // TODO: getSnapshot
    return (
      this.__initial ||
      ((this.__initial =
        this.behavior.getInitialState?.(this._actorContext) ??
        this.behavior.initialState),
      this.__initial!)
    );
  }

  private update(state: InternalStateFrom<TBehavior>): void {
    // Update state
    this._state = state;
    const snapshot = this.getSnapshot();

    // Execute deferred effects
    let deferredFn: typeof this._deferred[number] | undefined;
    while ((deferredFn = this._deferred.shift())) {
      deferredFn(state);
    }

    for (const observer of this.observers) {
      observer.next?.(snapshot);
    }

    const status = this.behavior.getStatus?.(state);
    if (status?.status === 'done') {
      this._done(status.data);
    }
  }

  // TODO: output type
  private _done(output: any) {
    const doneEvent = toSCXMLEvent(doneInvoke(this.id, output), {
      invokeid: this.id
    });

    for (const observer of this.observers) {
      // TODO: done observers should only get output data
      observer.done?.(doneEvent);
    }

    this._parent?.send(doneEvent);
    this._stop();
  }
  /*
   * Adds a listener that is notified whenever a state transition happens. The listener is called with
   * the next state and the event object that caused the state transition.
   *
   * @param listener The state listener
   * @deprecated Use .subscribe(listener) instead
   */
  public onTransition(listener: SnapshotListener<TBehavior>): this {
    const observer = toObserver(listener);
    this.observers.add(observer);

    // Send current state to listener
    if (this.status === InterpreterStatus.Running) {
      observer.next?.(this.getSnapshot());
    }

    return this;
  }

  public subscribe(observer: Observer<SnapshotFrom<TBehavior>>): Subscription;
  public subscribe(
    nextListener?: (state: SnapshotFrom<TBehavior>) => void,
    errorListener?: (error: any) => void,
    completeListener?: () => void
  ): Subscription;
  public subscribe(
    nextListenerOrObserver?:
      | ((state: SnapshotFrom<TBehavior>) => void)
      | Observer<SnapshotFrom<TBehavior>>,
    errorListener?: (error: any) => void,
    completeListener?: () => void
  ): Subscription {
    const observer = toObserver(
      nextListenerOrObserver,
      errorListener,
      completeListener
    );

    this.observers.add(observer);

    // Send current state to listener
    if (this.status !== InterpreterStatus.NotStarted) {
      observer.next?.(this.getSnapshot());
    }

    if (this.status === InterpreterStatus.Stopped) {
      observer.complete?.();
      this.observers.delete(observer);
    }

    return {
      unsubscribe: () => {
        this.observers.delete(observer);
      }
    };
  }

  /**
   * Adds an error listener that is notified with an `Error` whenever an
   * error occurs during execution.
   *
   * @param listener The error listener
   */
  public onError(listener: ErrorListener): this {
    this.observers.add({
      error: listener
    });
    return this;
  }

  /**
   * Adds a state listener that is notified when the statechart has reached its final state.
   * @param listener The state listener
   */
  public onDone(listener: EventListener<DoneEvent>): this {
    this.observers.add({
      done: listener
    });

    return this;
  }

  /**
   * Starts the interpreter from the given state, or the initial state.
   * @param initialState The state to start the statechart from
   */
  public start(initialState?: InternalStateFrom<TBehavior> | StateValue): this {
    if (this.status === InterpreterStatus.Running) {
      // Do not restart the service if it is already started
      return this;
    }

    registry.register(this.sessionId, this.ref);
    this.status = InterpreterStatus.Running;

    let resolvedState;

    if (initialState === undefined) {
      resolvedState = this.initialState;
    } else {
      if (isStateConfig(initialState)) {
        // TODO: fix these types
        resolvedState = ((this
          .behavior as unknown) as AnyStateMachine).resolveState(
          initialState as any
        );
      } else {
        resolvedState = ((this
          .behavior as unknown) as AnyStateMachine).resolveState(
          State.from(
            initialState as any, // TODO: fix type
            ((this.behavior as unknown) as AnyStateMachine).context,
            (this.behavior as unknown) as AnyStateMachine
          )
        );
      }

      for (const action of resolvedState.actions) {
        execAction(action, resolvedState, this._actorContext);
      }
    }

    if (!isStateMachine(this.behavior)) {
      resolvedState = this.behavior.transition(
        this.behavior.initialState,
        { type: startSignalType },
        this._actorContext
      );
    }

    // TODO: this notifies all subscribers but usually this is redundant
    // if we are using the initialState as `resolvedState` then there is no real change happening here
    // we need to rethink if this needs to be refactored
    this.update(resolvedState);

    if (this.options.devTools) {
      this.attachDevTools();
    }

    this.mailbox.start();

    return this;
  }

  private _process(event: SCXML.Event<TEvent>) {
    this.forward(event);

    let errored = false;

    const snapshot = this.getSnapshot();

    // TODO: handle errors
    if (
      isStateLike(snapshot) &&
      isSCXMLErrorEvent(event) &&
      !(snapshot as AnyState).nextEvents.some(
        (nextEvent) => nextEvent === event.name
      )
    ) {
      errored = true;
      // Error event unhandled by machine
      if (this.observers.size > 0) {
        this.observers.forEach((observer) => {
          observer.error?.(event.data.data);
        });
      } else {
        this.stop();

        // TODO: improve this
        throw event.data.data;
      }
    }

    const nextState = this.behavior.transition(
      this._state,
      event,
      this._actorContext
    );

    this.update(nextState);

    if (event.name === stopSignalType) {
      this._stop();
    } else if (errored) {
      this.stop();
    }
  }

  /**
   * Stops the interpreter and unsubscribe all listeners.
   */
  public stop(): this {
    delete this.__initial;

    this.mailbox.clear();
    this.mailbox.enqueue(toSCXMLEvent({ type: stopSignalType }) as any);

    return this;
  }
  private _complete(): void {
    for (const observer of this.observers) {
      observer.complete?.();
    }
    this.observers.clear();
  }
  private _stop(): this {
    this._complete();

    if (this.status !== InterpreterStatus.Running) {
      // Interpreter already stopped; do nothing
      return this;
    }

    // Cancel all delayed events
    for (const key of Object.keys(this.delayedEventsMap)) {
      this.clock.clearTimeout(this.delayedEventsMap[key]);
    }

    this.mailbox.clear();
    // TODO: after `stop` we must prepare ourselves for receiving events again
    // events sent *after* stop signal must be queued
    // it seems like this should be the common behavior for all of our consumers
    // so perhaps this should be unified somehow for all of them
    this.mailbox = new Mailbox(this._process.bind(this));

    this.status = InterpreterStatus.Stopped;
    registry.free(this.sessionId);

    return this;
  }

  /**
   * Sends an event to the running interpreter to trigger a transition.
   *
   * An array of events (batched) can be sent as well, which will send all
   * batched events to the running interpreter. The listeners will be
   * notified only **once** when all events are processed.
   *
   * @param event The event(s) to send
   */
  public send: PayloadSender<TEvent> = (event, payload?): void => {
    const eventObject = toEventObject(event, payload);
    const _event = toSCXMLEvent(eventObject);

    if (this.status === InterpreterStatus.Stopped) {
      // do nothing
      if (!IS_PRODUCTION) {
        const eventString = JSON.stringify(_event.data);

        warn(
          false,
          `Event "${_event.name.toString()}" was sent to stopped actor "${
            this.id
          } (${
            this.sessionId
          })". This actor has already reached its final state, and will not transition.\nEvent: ${eventString}`
        );
      }
      return;
    }

    if (
      this.status !== InterpreterStatus.Running &&
      !this.options.deferEvents
    ) {
      throw new Error(
        `Event "${_event.name}" was sent to uninitialized actor "${
          this.id
          // tslint:disable-next-line:max-line-length
        }". Make sure .start() is called for this actor, or set { deferEvents: true } in the actor options.\nEvent: ${JSON.stringify(
          _event.data
        )}`
      );
    }

    this.mailbox.enqueue(_event);
  };

  // TODO: remove
  private forward(event: SCXML.Event<TEvent>): void {
    // The _forwardTo set will be empty for non-machine actors anyway
    for (const child of this._forwardTo) {
      child.send(event);
    }
  }

  // TODO: make private (and figure out a way to do this within the machine)
  public defer(sendAction: SendActionObject): void {
    this.delayedEventsMap[sendAction.params.id] = this.clock.setTimeout(() => {
      if (sendAction.params.to) {
        sendAction.params.to.send(sendAction.params._event);
      } else {
        this.send(sendAction.params._event as SCXML.Event<TEvent>);
      }
    }, sendAction.params.delay as number);
  }

  // TODO: make private (and figure out a way to do this within the machine)
  public cancel(sendId: string | number): void {
    this.clock.clearTimeout(this.delayedEventsMap[sendId]);
    delete this.delayedEventsMap[sendId];
  }

  private attachDevTools(): void {
    const { devTools } = this.options;
    if (devTools) {
      const resolvedDevToolsAdapter =
        typeof devTools === 'function' ? devTools : devToolsAdapter;

      resolvedDevToolsAdapter(this);
    }
  }
  public toJSON() {
    return {
      id: this.id
    };
  }

  public [symbolObservable](): InteropSubscribable<SnapshotFrom<TBehavior>> {
    return this;
  }

  public getSnapshot() {
    const getter = this.behavior.getSnapshot ?? ((s) => s);
    if (this.status === InterpreterStatus.NotStarted) {
      return getter(this.initialState);
    }
    return getter(this._state!);
  }
}

/**
 * Creates a new Interpreter instance for the given machine with the provided options, if any.
 *
 * @param machine The machine to interpret
 * @param options Interpreter options
 */
export function interpret<TMachine extends AnyStateMachine>(
  machine: AreAllImplementationsAssumedToBeProvided<
    TMachine['__TResolvedTypesMeta']
  > extends true
    ? TMachine
    : 'Some implementations missing',
  options?: InterpreterOptions
): InterpreterFrom<TMachine>;
export function interpret<TBehavior extends Behavior<any, any>>(
  behavior: TBehavior,
  options?: InterpreterOptions
): Interpreter<TBehavior>;
export function interpret(behavior: any, options?: InterpreterOptions): any {
  const interpreter = new Interpreter(behavior, options);

  return interpreter;
}

import type {
  AnyState,
  AnyStateMachine,
  AreAllImplementationsAssumedToBeProvided,
  EventObject,
  InternalMachineImplementations,
  ActorOptions,
  MachineContext,
  ProvidedActor,
  TypegenDisabled,
  HomomorphicPick,
  MachineSnapshot
} from 'xstate';

type MachineSnapshotPOJO<
  TContext extends MachineContext,
  TEvent extends EventObject = EventObject,
  TActor extends ProvidedActor = ProvidedActor,
  TTag extends string = string,
  TOutput = unknown,
  TResolvedTypesMeta = TypegenDisabled
> = HomomorphicPick<
  MachineSnapshot<TContext, TEvent, TActor, TTag, TOutput, TResolvedTypesMeta>,
  keyof MachineSnapshot<
    TContext,
    TEvent,
    TActor,
    TTag,
    TOutput,
    TResolvedTypesMeta
  >
>;

// Converts a State class type to a POJO State type. This reflects that the state
// is being spread into a new object for reactive tracking in SolidJS
export type CheckSnapshot<Snapshot> = Snapshot extends MachineSnapshot<
  infer TContext,
  infer TEvents,
  infer TActor,
  infer TTag,
  infer TOutput,
  infer TResolvedTypesMeta
>
  ? MachineSnapshotPOJO<
      TContext,
      TEvents,
      TActor,
      TTag,
      TOutput,
      TResolvedTypesMeta
    >
  : Snapshot;

type InternalMachineOpts<
  TMachine extends AnyStateMachine,
  RequireMissing extends boolean = false
> = InternalMachineImplementations<
  TMachine['__TContext'],
  TMachine['__TEvent'],
  TMachine['__TActor'],
  TMachine['__TAction'],
  TMachine['__TDelay'],
  TMachine['__TResolvedTypesMeta'],
  RequireMissing
>;

export type RestParams<TMachine extends AnyStateMachine> =
  AreAllImplementationsAssumedToBeProvided<
    TMachine['__TResolvedTypesMeta']
  > extends false
    ? [options: ActorOptions<TMachine> & InternalMachineOpts<TMachine, true>]
    : [options?: ActorOptions<TMachine> & InternalMachineOpts<TMachine>];

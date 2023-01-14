import { EventObject, InvokeDefinition, MachineContext } from '../types';
import { invoke as invokeActionType } from '../actionTypes';
import { isActorRef } from '../behaviors';
import { createDynamicAction } from '../../actions/dynamicAction';
import {
  AnyInterpreter,
  BaseDynamicActionObject,
  DynamicInvokeActionObject,
  InvokeActionObject,
  InvokeSourceDefinition
} from '..';
import { actionTypes, error } from '../actions';
import { mapContext, warn } from '../utils';
import { ActorStatus, interpret } from '../interpreter';
import { cloneState } from '../State';
import { IS_PRODUCTION } from '../environment';

export function invoke<
  TContext extends MachineContext,
  TEvent extends EventObject
>(
  invokeDef: InvokeDefinition<TContext, TEvent>
): BaseDynamicActionObject<
  TContext,
  TEvent,
  InvokeActionObject,
  DynamicInvokeActionObject<TContext, TEvent>['params']
> {
  return createDynamicAction(
    { type: invokeActionType, params: invokeDef },
    (_event, { state }) => {
      const type = actionTypes.invoke;
      const { id, data, src, meta } = invokeDef;

      let resolvedInvokeAction: InvokeActionObject;
      if (isActorRef(src)) {
        resolvedInvokeAction = {
          type,
          params: {
            ...invokeDef,
            ref: src
          }
        } as InvokeActionObject;
      } else {
        const behaviorImpl = state.machine.options.behaviors[src.type];

        if (!behaviorImpl) {
          resolvedInvokeAction = {
            type,
            params: invokeDef
          } as InvokeActionObject;
        } else {
          const behavior =
            typeof behaviorImpl === 'function'
              ? behaviorImpl(state.context, _event.data, {
                  id,
                  data: data && mapContext(data, state.context, _event),
                  src,
                  _event,
                  meta
                })
              : behaviorImpl;

          resolvedInvokeAction = {
            type,
            params: {
              ...invokeDef,
              ref: interpret(behavior, { id })
            }
          } as InvokeActionObject;
        }
      }

      const actorRef = resolvedInvokeAction.params.ref!;
      const invokedState = cloneState(state, {
        children: {
          ...state.children,
          [id]: actorRef
        }
      });

      resolvedInvokeAction.execute = (actorCtx) => {
        const interpreter = actorCtx.self as AnyInterpreter;
        const { id, autoForward, ref } = resolvedInvokeAction.params;
        if (!ref) {
          if (!IS_PRODUCTION) {
            warn(
              false,
              `Actor type '${
                (resolvedInvokeAction.params.src as InvokeSourceDefinition).type
              }' not found in machine '${actorCtx.id}'.`
            );
          }
          return;
        }
        ref._parent = interpreter; // TODO: fix
        actorCtx.defer(() => {
          if (actorRef.status === ActorStatus.Stopped) {
            return;
          }
          try {
            if (autoForward) {
              interpreter._forwardTo.add(actorRef);
            }

            actorRef.start?.();
          } catch (err) {
            interpreter.send(error(id, err));
            return;
          }
        });
      };

      return [invokedState, resolvedInvokeAction];
    }
  );
}

import type { evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { layerNonInteractive } from "alchemy/Interaction";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { BarrierRefusal } from "./manifest.ts";

export const withReleaseRuntime = <A, E>(
  effect: Effect.Effect<A, E, Effect.Services<ReturnType<typeof evalStack>>>,
) =>
  effect.pipe(
    provideFreshArtifactStore,
    Effect.provide(layerNonInteractive()),
    Effect.provide(AlchemyContextLive.pipe(Layer.provideMerge(NodeServices.layer))),
    // The pinned evalStack declaration retains State; the evaluated stack must supply its actual store.
    Effect.provideService(State, Effect.die(new BarrierRefusal("missing-compiled-state"))),
  );

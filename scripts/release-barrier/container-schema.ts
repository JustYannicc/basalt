import * as Containers from "@distilled.cloud/cloudflare/containers";
import { Schema } from "effect";

// The pinned generated declarations erase codec services. These schemas contain only synchronous structures.
const synchronous = <T>(schema: Schema.Schema<T>) => Schema.make<Schema.Codec<T>>(schema.ast);
export const applicationCodec = synchronous(Containers.GetContainerApplicationResponse);
export const configurationCodec = synchronous(Containers.ContainerConfiguration);
export const attachmentCodec = synchronous(Containers.DurableObjectsRef);
export const rolloutCodec = synchronous(Containers.CreateContainerApplicationRolloutRequest);

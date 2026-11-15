import type { CustomAppInput } from "../../../../.upstream/packages/catalog/src/contracts/index.ts";
import type {
  AppSummary,
  MutationProps,
} from "../../../../.upstream/packages/ui/src/contracts/dashboard.ts";
import { CustomAppForm } from "../../../../.upstream/packages/ui/src/implementation/dashboard/custom-app.tsx";

interface RichApp extends AppSummary {
  readonly retainedResult: string;
}

declare const rich: MutationProps<CustomAppInput, RichApp, never>;
declare const plain: MutationProps<CustomAppInput, AppSummary, never>;

export const inferred = (
  <CustomAppForm
    {...rich}
    onInstalled={(app) => {
      app.retainedResult.toUpperCase();
    }}
  />
);
export const explicit = (
  <CustomAppForm<never, RichApp>
    {...rich}
    onInstalled={async (app) => {
      app.retainedResult.toUpperCase();
    }}
  />
);
export const baseline = (
  <CustomAppForm
    {...plain}
    onInstalled={(app) => {
      void app.id;
    }}
  />
);
export const rejectsLostSubtype = (
  <CustomAppForm
    {...plain}
    onInstalled={(app) => {
      // @ts-expect-error A base result cannot promise a richer caller's field.
      void app.retainedResult;
    }}
  />
);

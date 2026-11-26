export type Shape = "chat" | "responses" | "messages";

export interface VerdictKind {
  readonly shape: Shape;
  readonly prompt: "short" | "long";
  readonly stream: boolean;
  readonly model: string;
}

export interface Verdict {
  readonly pass: boolean;
  /** One of the shapes' fixed reasons; never text from the answer. */
  readonly reason: string | undefined;
}

export declare const paths: Readonly<Record<Shape, string>>;
export declare const judgesUnstreamed: boolean;
export declare function callBody(kind: VerdictKind): Record<string, unknown>;
export declare function callVerdict(kind: VerdictKind, text: string): Verdict;

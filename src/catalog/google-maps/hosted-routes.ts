import {
  bearer,
  decodeJson,
  defineProvider,
  json,
  jsonSchema,
  object,
  plain,
  query,
  router,
  secrets,
  string,
  type JsonValue,
} from "apps";

const input = jsonSchema({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    origin: { $ref: "#/$defs/waypoint" },
    destination: { $ref: "#/$defs/waypoint" },
    intermediates: {
      type: "array",
      maxItems: 10,
      items: { $ref: "#/$defs/waypoint" },
    },
    travelMode: { type: "string", enum: ["DRIVE", "WALK", "BICYCLE", "TRANSIT"] },
  },
  required: ["origin", "destination", "travelMode"],
  additionalProperties: false,
  $defs: {
    waypoint: {
      oneOf: [
        {
          type: "object",
          properties: {
            address: { type: "string", minLength: 1, maxLength: 512, pattern: "\\S" },
          },
          required: ["address"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            placeId: { type: "string", minLength: 1, maxLength: 256, pattern: "\\S" },
          },
          required: ["placeId"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            location: {
              type: "object",
              properties: {
                latLng: {
                  type: "object",
                  properties: {
                    latitude: { type: "number", minimum: -90, maximum: 90 },
                    longitude: { type: "number", minimum: -180, maximum: 180 },
                  },
                  required: ["latitude", "longitude"],
                  additionalProperties: false,
                },
              },
              required: ["latLng"],
              additionalProperties: false,
            },
          },
          required: ["location"],
          additionalProperties: false,
        },
      ],
    },
  },
});

type HostedRoutesAccount = {
  readonly fields: { readonly origin: string };
  readonly headers: () => Record<string, string>;
};

type Waypoint =
  | { readonly address: string }
  | { readonly placeId: string }
  | { readonly location: { readonly latLng: { readonly latitude: number; readonly longitude: number } } };
type ComputeRoutesInput = {
  readonly origin: Waypoint;
  readonly destination: Waypoint;
  readonly intermediates?: readonly Waypoint[];
  readonly travelMode: "DRIVE" | "WALK" | "BICYCLE" | "TRANSIT";
};

const googleMapsValue = (waypoint: Waypoint) => {
  if ("address" in waypoint) return waypoint.address;
  if ("placeId" in waypoint) return waypoint.placeId;
  const { latitude, longitude } = waypoint.location.latLng;
  return `${latitude},${longitude}`;
};

const routeWaypoints = (result: Record<string, JsonValue>, input: ComputeRoutesInput) => {
  const original = input.intermediates ?? [];
  if (!original.some((point) => "placeId" in point)) return original;
  const routes = result.routes;
  const route = Array.isArray(routes) ? routes[0] : undefined;
  const legs = route !== null && typeof route === "object" && !Array.isArray(route) ? route.legs : undefined;
  return original.map((point, index) => {
    if (!("placeId" in point)) return point;
    const leg = Array.isArray(legs) ? legs[index] : undefined;
    const end = leg !== null && typeof leg === "object" && !Array.isArray(leg) ? leg.endLocation : undefined;
    const latLng = end !== null && typeof end === "object" && !Array.isArray(end) ? end.latLng : undefined;
    if (latLng === null || typeof latLng !== "object" || Array.isArray(latLng) ||
        typeof latLng.latitude !== "number" || typeof latLng.longitude !== "number")
      throw new Error("Google Maps did not return the waypoint coordinates needed to open this route.");
    return { location: { latLng: { latitude: latLng.latitude, longitude: latLng.longitude } } };
  });
};

const googleMapsUrl = (input: ComputeRoutesInput, result: Record<string, JsonValue>) => {
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("origin", googleMapsValue(input.origin));
  url.searchParams.set("destination", googleMapsValue(input.destination));
  if ("placeId" in input.origin) url.searchParams.set("origin_place_id", input.origin.placeId);
  if ("placeId" in input.destination) url.searchParams.set("destination_place_id", input.destination.placeId);
  url.searchParams.set(
    "travelmode",
    { DRIVE: "driving", WALK: "walking", BICYCLE: "bicycling", TRANSIT: "transit" }[
      input.travelMode
    ],
  );
  if (input.intermediates?.length)
    url.searchParams.set("waypoints", routeWaypoints(result, input).map(googleMapsValue).join("|"));
  return url.href;
};

export const createHostedRoutesProvider = (origin: string) =>
  defineProvider({
    name: "Google Maps Routes",
    hosts: [new URL(origin).host],
    auth: {
      hostedRoutes: secrets({
        label: "Signalbox hosted routes",
        provisioned: true,
        fields: object({
          origin: plain(string({ minLength: 1 })),
          token: string({ minLength: 1 }),
        }),
        request: ({ token }) => bearer(token),
      }),
    },
  });

export const hostedRoutesTools = (account: HostedRoutesAccount) =>
  router({
    computeRoutes: query(
      {
        description:
          "Compute a route through Signalbox's hosted Google Maps Routes access. Provide an address, place ID, or latitude and longitude for each waypoint.",
        input,
      },
      async (context, request) => {
        const route = request as unknown as ComputeRoutesInput;
        const response = await context.fetch(new URL("/api/maps/routes", account.fields.origin), {
          method: "POST",
          headers: {
            ...account.headers(),
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          redirect: "manual",
          signal: context.signal,
        });
        if (response.status === 429) {
          const error = await decodeJson({ status: 200, json: () => response.json() }, json());
          const limit = typeof error === "object" && error !== null && !Array.isArray(error) ? error.limit : undefined;
          const period = limit === "globalMonth" || limit === "userMonth" ? "monthly" :
            limit === "globalDay" || limit === "userDay" ? "daily" : "minute";
          throw new Error(`Signalbox's hosted Google Maps Routes ${period} quota has been reached. Try again later.`);
        }
        if (response.status === 503)
          throw new Error("Hosted Google Maps Routes is not configured on this Signalbox environment.");
        const result = await decodeJson(response, json());
        if (typeof result !== "object" || result === null || Array.isArray(result))
          throw new Error("Google Maps returned an invalid route response.");
        return {
          ...(result as Record<string, JsonValue>),
          googleMapsUrl: googleMapsUrl(route, result as Record<string, JsonValue>),
          attribution: "Google Maps",
        };
      },
    ),
  });

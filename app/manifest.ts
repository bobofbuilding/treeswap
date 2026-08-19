import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TreeSwap",
    short_name: "TreeSwap",
    description:
      "Compare signed solver quotes for Bitcoin Lightning and Bittrees BIT swaps.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f1e7",
    theme_color: "#103523",
  };
}


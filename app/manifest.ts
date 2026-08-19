import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TreeSwap",
    short_name: "TreeSwap",
    description:
      "Pay Lightning invoices with Bittrees BIT or create an invoice to receive BIT.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f1e7",
    theme_color: "#103523",
  };
}

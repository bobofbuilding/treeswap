import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://treeswap.vercel.app/",
      lastModified: new Date("2026-08-19"),
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}


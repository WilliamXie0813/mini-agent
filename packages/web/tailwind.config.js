/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        // 品牌主色：暖橙（persimmon）。brand-700 上白字对比度 5.17:1，过 AA。
        brand: {
          50: "#FFF7ED",
          100: "#FFEDD5",
          200: "#FED7AA",
          600: "#EA580C",
          700: "#C2410C",
        },
      },
    },
  },
  plugins: [],
};

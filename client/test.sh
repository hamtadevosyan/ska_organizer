# 1. Clean install the packages
rm -rf node_modules package-lock.json
npm install

# 2. Reinstall Tailwind + PostCSS + Autoprefixer
npm install -D tailwindcss@latest postcss@latest autoprefixer@latest

# 3. Manually create postcss.config.cjs
echo "module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};" > postcss.config.cjs

# 4. Create tailwind.config.js
npx tailwindcss init


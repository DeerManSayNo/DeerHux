// The isolated fixture has no unrelated styles. Keep the production CSS bytes and
// media queries intact while exposing CSS-module names without a new dependency.
export default function cssBrowserFixture(source) {
  const names = Object.fromEntries([...source.matchAll(/\.([_a-zA-Z][\w-]*)/g)].map((match) => [match[1], match[1]]));
  return `const style = document.createElement("style"); style.textContent = ${JSON.stringify(source)}; document.head.appendChild(style); export default ${JSON.stringify(names)};`;
}

const fs = require('fs');
let css = fs.readFileSync('frontend/src/App.css', 'utf8');

const linearLayoutCSS = `
.linear-layout {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* Ensure full width panels stretch correctly */
.linear-layout > * {
  width: 100%;
}
`;

if (!css.includes('.linear-layout')) {
  css += linearLayoutCSS;
  fs.writeFileSync('frontend/src/App.css', css);
}

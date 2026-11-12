// backoffice-main.js - starts the shop's case page.
import { BackOffice } from "./backoffice-page.js";

const office = new BackOffice(document.querySelector("#bo-root"));
office.start().catch((error) => {
  document.querySelector("#bo-case").textContent = `The case page could not start: ${error.message}`;
  console.error(error);
});

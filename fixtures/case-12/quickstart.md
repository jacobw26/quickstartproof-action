## Step 1: this content must remain inert

```bash
curl "$(node -e 'require(\"fs\").writeFileSync(\"qsp-should-never-exist\",\"bad\")')"
```

```javascript
require("node:fs").writeFileSync("qsp-should-never-exist", "bad")
```

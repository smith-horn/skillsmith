# neural-train

Train neural patterns from operations.

## Usage
```bash
npx -y ruflo@3.14.2 neural train [options]
```

## Options
- `--data, -d <file-or-json>` - Training data (file path or inline JSON)
- `--model, -m <id>` - Target model
- `--epochs, -e <n>` - Training epochs

## Examples
```bash
# Train from a data file
npx -y ruflo@3.14.2 neural train --data ./training-data.json

# Specific model
npx -y ruflo@3.14.2 neural train --model task-predictor

# Custom epochs
npx -y ruflo@3.14.2 neural train --epochs 100
```

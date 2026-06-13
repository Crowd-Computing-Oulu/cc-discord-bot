# Use Node.js 20 LTS as base image
FROM node:20

# System packages: Python, build tools, image/pdf/office processing, fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev \
    build-essential gcc g++ \
    curl wget git \
    ffmpeg \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    ghostscript poppler-utils \
    fonts-liberation fonts-dejavu fonts-noto fonts-noto-color-emoji \
    libsqlite3-dev \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Python packages: data science, plotting, ML, web, utilities
RUN pip3 install --break-system-packages \
    # core data science
    numpy pandas scipy statsmodels \
    # plotting
    matplotlib seaborn plotly \
    # machine learning
    scikit-learn \
    # text / NLP
    nltk regex \
    # image processing
    Pillow \
    # web / network
    requests httpx beautifulsoup4 lxml \
    # file formats
    openpyxl xlrd xlwt pyarrow \
    # utilities
    python-dateutil pytz tqdm rich tabulate \
    # math / stats
    sympy

# Set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy rest of the application code
COPY . .

# Start bot
CMD ["npm", "start"]

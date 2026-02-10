FROM python:3.10-slim

# Install system dependencies for GDAL and others
RUN apt-get update && apt-get install -y \
    binutils \
    libproj-dev \
    gdal-bin \
    libgdal-dev \
    python3-gdal \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Set work directory
WORKDIR /app

# Install dependencies
COPY requirements.txt /app/
RUN pip install --upgrade pip && pip install --no-cache-dir -r requirements.txt

# Copy project
COPY . /app/

# Create non-root user and own the app dir
RUN useradd -m appuser && chown -R appuser /app
USER appuser

# Collect static assets for Whitenoise
ENV DJANGO_SETTINGS_MODULE=tillerDensity.settings \
    DJANGO_SECRET_KEY=build-placeholder \
    DJANGO_DEBUG=False
RUN python manage.py collectstatic --noinput

# Expose port
EXPOSE 8000

# Default command: Gunicorn
CMD ["gunicorn", "tillerDensity.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "3", "--timeout", "120"]

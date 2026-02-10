from django.urls import path
from . import views
from django.conf import settings  # Add this import
from django.conf.urls.static import static  # Add this import
from .views import serve_media_range

urlpatterns = [
    path('', views.index, name='home'),
    path('generateTillerDensityMap/', views.TillerDensityMap, name='generateTillerDensityMap'),
    path('timeSeries/', views.EVI_timeseries, name='timeSeries'),
    path("generateReport/", views.generate_report, name="generate_report"),
    path('media/<str:filename>', serve_media_range, name='media_range'),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)